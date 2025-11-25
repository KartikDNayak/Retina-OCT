
import { GoogleGenAI, Type } from "@google/genai";
import type { AnalysisResult } from '../types';

const fileToGenerativePart = async (file: File) => {
  const base64EncodedDataPromise = new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve((reader.result as string).split(',')[1]);
    reader.readAsDataURL(file);
  });
  return {
    inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
  };
};

const parseApiError = (error: unknown): string => {
    if (error instanceof Error) {
        const message = error.message.toLowerCase();
        if (message.includes('api key not valid')) {
            return 'Invalid API Key. Please ensure your API key is correctly configured in your environment variables.';
        }
        if (message.includes('quota') || message.includes('rate limit')) {
            return 'API Quota Exceeded. Please wait a moment before trying again.';
        }
        if (message.includes('blocked') || message.includes('safety')) {
            return 'Content Safety Error. The request was blocked due to safety settings.';
        }
        if (message.includes('server error') || message.includes('500')) {
             return 'AI Service Unavailable. Please try again later.';
        }
        if (message.includes('abort') || error.name === 'AbortError') {
            return 'Request cancelled by user.';
        }
        return error.message;
    }
    return 'An unexpected error occurred during the analysis.';
}

const extractImageFromResponse = (response: any, errorContext: string): string => {
    const part = response.candidates?.[0]?.content?.parts?.[0];
    if (part && 'inlineData' in part && part.inlineData?.data) {
        return part.inlineData.data;
    }
    throw new Error(`${errorContext} or received empty image data.`);
};

// Retry utility with exponential backoff
const retryWithBackoff = async <T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> => {
    try {
        return await fn();
    } catch (error: any) {
        if (retries === 0 || error.name === 'AbortError') throw error;
        
        // Only retry on 429, 500, 503 or network errors
        const msg = error.message.toLowerCase();
        if (msg.includes('quota') || msg.includes('rate limit') || msg.includes('server error') || msg.includes('unavailable')) {
             await new Promise(resolve => setTimeout(resolve, delay));
             return retryWithBackoff(fn, retries - 1, delay * 2);
        }
        throw error;
    }
};

export const analyzeImage = async (
    imageFile: File, 
    refinementFeedback?: string, 
    debugId?: string,
    signal?: AbortSignal
): Promise<{ analysis: AnalysisResult, segmentedImageBase64?: string, heatmapImageBase64: string, segmentationUncertaintyMapBase64?: string }> => {
  
  if (!process.env.API_KEY) {
    throw new Error("API Key Not Found. Please configure API_KEY.");
  }
  
  // Check abort before starting
  if (signal?.aborted) throw new Error("Request cancelled");

  try {
    const ai = new GoogleGenAI({ 
        apiKey: process.env.API_KEY
    });
    
    const imagePart = await fileToGenerativePart(imageFile);

    // Helper to create API calls with abort check
    const makeRequest = async (fn: () => Promise<any>) => {
        if (signal?.aborted) throw new Error("Request cancelled");
        return await fn();
    };

    // Task 1: Parallel Execution with Retries
    const segmentationPromise = refinementFeedback ? Promise.resolve(null) : retryWithBackoff(() => makeRequest(() => ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
          parts: [
              imagePart,
              { text: `Generate a medical segmentation map. Use distinct colors: Blue=Fluid, Yellow=Drusen, Red=CNV, Green=Healthy. Embed a legend.`}
          ]
      },
      config: { responseModalities: ['IMAGE'] }
    })));
    
    const segmentationUncertaintyPromise = refinementFeedback ? Promise.resolve(null) : retryWithBackoff(() => makeRequest(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: {
            parts: [
                imagePart,
                { text: `Generate a segmentation uncertainty map (cool-to-warm scale). Highlight fuzzy fluid edges and indistinct layers in warm colors.`}
            ]
        },
        config: { responseModalities: ['IMAGE'] }
    })));

    const classificationSchema = {
      type: Type.OBJECT,
      properties: {
          diagnosis: { type: Type.STRING, description: "Diagnosis: 'AMD', 'CNV', 'DME', 'Drusen', 'Normal', 'Geographic Atrophy'." },
          confidence: { type: Type.STRING, description: "Confidence percentage." },
          explanation: { type: Type.STRING, description: "Visual evidence explanation." },
          explainability: { type: Type.STRING, description: "Model interpretability." },
          uncertaintyStatement: { type: Type.STRING, description: "Diagnostic uncertainty." },
          segmentationUncertaintyStatement: { type: Type.STRING, description: "Segmentation uncertainty." },
          anomalyReport: { type: Type.STRING, description: "Ancillary findings." },
          processedId: { type: Type.STRING, description: "The EXACT verification ID provided in the prompt." }
      },
      required: ["diagnosis", "confidence", "explanation", "explainability", "uncertaintyStatement", "segmentationUncertaintyStatement", "processedId"]
    };
    
    let classificationPrompt = `
      Analyze this retinal OCT image.
      
      VERIFICATION ID: "${debugId}"
      IMPORTANT: You MUST echo back this ID exactly in the 'processedId' JSON field. This is critical for patient safety verification.

      Strictly differentiate:
      - Fluid (DME/CNV) vs Deposits (Drusen).
      - Wet AMD (CNV + Fluid) vs Dry AMD (Drusen/GA).
      - DME (Fluid without CNV membrane).
      
      Priority:
      1. FLUID? -> Wet (CNV or DME).
      2. NO FLUID? -> Dry (GA, AMD, Drusen, Normal).
      
      Check for Geographic Atrophy in dry scans.
      Check for Neovascular Membrane to distinguish CNV from DME.
      
      Anti-Hallucination Protocol:
      - Do NOT invent features. 
      - Evidence must be visible.
      - Do NOT use generic definitions. Describe morphology specific to THIS image.
      
      Output JSON.
    `;

    if (refinementFeedback) {
        classificationPrompt += `\n\nRefinement Feedback: "${refinementFeedback}". Re-evaluate based on this.`;
    }

    const classificationPromise = retryWithBackoff(() => makeRequest(() => ai.models.generateContent({
      model: 'gemini-3-pro-preview',
      contents: { parts: [imagePart, {text: classificationPrompt}]},
      config: {
          responseMimeType: "application/json",
          responseSchema: classificationSchema,
      }
    })));

    let heatmapPrompt = `Generate an attention heatmap (warm colors) for pathology (fluid, lesions). Desaturate background.`;
    if (refinementFeedback) {
        heatmapPrompt = `Generate a NEW heatmap focusing on: "${refinementFeedback}".`;
    }

    const heatmapPromise = retryWithBackoff(() => makeRequest(() => ai.models.generateContent({
        model: 'gemini-2.5-flash-image',
        contents: { parts: [imagePart, { text: heatmapPrompt }] },
        config: { responseModalities: ['IMAGE'] }
    })));

    const [segResp, segUncertResp, classResp, heatResp] = await Promise.all([
      segmentationPromise, segmentationUncertaintyPromise, classificationPromise, heatmapPromise
    ]);
    
    if (signal?.aborted) throw new Error("Request cancelled");

    const classificationText = classResp?.text?.trim();
    if (!classificationText) throw new Error("Empty classification response.");

    let analysisResult: AnalysisResult;
    try {
      analysisResult = JSON.parse(classificationText);
    } catch (e) {
      throw new Error("Invalid JSON response from AI.");
    }

    // Post-processing: Confidence Check
    const confidenceValue = parseFloat(analysisResult.confidence);
    const CONFIDENCE_THRESHOLD = 70;
    if (!isNaN(confidenceValue) && confidenceValue < CONFIDENCE_THRESHOLD) {
        const original = analysisResult.diagnosis;
        analysisResult.diagnosis = 'Requires Further Review';
        analysisResult.uncertaintyStatement = `**Low Confidence (${analysisResult.confidence})**: Initial finding '${original}'. Requires review. ${analysisResult.uncertaintyStatement}`;
    }
    
    // Verification Metadata (Simulated for client-side SDK, would come from backend normally)
    if (debugId) {
        // We rely on the model returning it in processedId, but we timestamp here
        analysisResult.timestampBackend = new Date().toISOString();
    }

    const heatmapImageBase64 = extractImageFromResponse(heatResp, "Heatmap generation failed");
    
    if (!segResp || !segUncertResp) {
      return { analysis: analysisResult, heatmapImageBase64 };
    }

    const segmentedImageBase64 = extractImageFromResponse(segResp, "Segmentation failed");
    const segmentationUncertaintyMapBase64 = extractImageFromResponse(segUncertResp, "Uncertainty map failed");

    return { analysis: analysisResult, segmentedImageBase64, heatmapImageBase64, segmentationUncertaintyMapBase64 };

  } catch (err) {
      console.error("Gemini API Error:", err);
      throw new Error(parseApiError(err));
  }
};
