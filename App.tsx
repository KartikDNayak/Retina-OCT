
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Header } from './components/Header';
import { ImageUploader } from './components/ImageUploader';
import { AnalysisResults } from './components/AnalysisResults';
import { analyzeImage } from './services/geminiService';
import { generateFileHash, debugRequest } from './utils/fileHelpers';
import { verifyMapping } from './utils/verifyMapping';
import type { AnalyzableImage } from './types';
import { CheckCircleIcon, RefreshIcon, AlertTriangleIcon, UploadIcon } from './components/icons';

const App: React.FC = () => {
  const [images, setImages] = useState<AnalyzableImage[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };
  }, []);

  const handleImageUpload = async (files: FileList) => {
    const newImagesProms = Array.from(files)
      .filter(file => file.type.startsWith('image/'))
      .map(async (file) => {
        const id = crypto.randomUUID();
        const hash = await generateFileHash(file);
        return {
          id,
          file,
          hash,
          previewUrl: URL.createObjectURL(file),
          status: 'pending' as const,
          mappingStatus: 'unverified' as const
        };
      });
    
    const newImages = await Promise.all(newImagesProms);
    setImages(prev => [...prev, ...newImages]);
    setError(null);
  };

  const runAnalysisLoop = async (candidates: AnalyzableImage[]) => {
      if (abortControllerRef.current) {
          abortControllerRef.current.abort();
      }
      const controller = new AbortController();
      abortControllerRef.current = controller;

      setIsAnalyzing(true);
      setError(null);

      // 1. Optimistic Update
      setImages(prev => prev.map(img => 
          candidates.some(c => c.id === img.id) ? { ...img, status: 'loading', error: undefined, mappingStatus: 'unverified' } : img
      ));

      for (const image of candidates) {
          if (controller.signal.aborted) break;

          try {
              // Debug log
              await debugRequest(image.file, image.id);

              // 2. Call API with ID for verification + Signal
              const result = await analyzeImage(image.file, undefined, image.id, controller.signal);
              
              // 3. Verify Mapping (Round Trip Check)
              // We check if the ID we sent came back in the AI response JSON
              const isVerified = await verifyMapping(image, result.analysis.processedId, undefined);
              
              const mappingStatus = isVerified ? 'verified' : 'mismatch';

              if (!isVerified) {
                 console.warn(`CRITICAL: Mapping mismatch for image ${image.id}. Response contained ID: ${result.analysis.processedId}`);
              }

              // 4. Functional State Update
              setImages(prev => prev.map(img => {
                  if (img.id !== image.id) return img;
                  
                  return {
                      ...img,
                      status: 'success',
                      mappingStatus: mappingStatus,
                      result: result.analysis,
                      segmentedImageUrl: result.segmentedImageBase64 ? `data:image/jpeg;base64,${result.segmentedImageBase64}` : img.segmentedImageUrl,
                      heatmapImageUrl: `data:image/jpeg;base64,${result.heatmapImageBase64}`,
                      segmentationUncertaintyMapUrl: result.segmentationUncertaintyMapBase64 ? `data:image/jpeg;base64,${result.segmentationUncertaintyMapBase64}` : img.segmentationUncertaintyMapUrl,
                      error: undefined
                  };
              }));

          } catch (err: any) {
              if (err.message === 'Request cancelled') {
                  console.log('Analysis cancelled');
                  break;
              }
              console.error(`Error analyzing ${image.id}:`, err);
              setImages(prev => prev.map(img =>
                  img.id === image.id ? { ...img, status: 'error', error: (err as Error).message } : img
              ));
          }
      }
      setIsAnalyzing(false);
      abortControllerRef.current = null;
  };

  const handleAnalyzeAll = useCallback(() => {
    const imagesToAnalyze = images.filter(img => img.status === 'pending');
    if (imagesToAnalyze.length > 0) {
        runAnalysisLoop(imagesToAnalyze);
    }
  }, [images]);

  const handleRetryFailed = useCallback(() => {
    const failedImages = images.filter(img => img.status === 'error');
    if (failedImages.length > 0) {
        runAnalysisLoop(failedImages);
    }
  }, [images]);
  
  const handleRefineAnalysis = useCallback(async (id: string, feedback: string) => {
    const imageToRefine = images.find(img => img.id === id);
    if (!imageToRefine) return;

    setImages(prev => prev.map(img => 
        img.id === id ? { ...img, status: 'loading', error: undefined } : img
    ));

    try {
        // We don't abort global queue for a single refinement, but we could add per-image controllers if needed.
        // For now, simple await.
        const result = await analyzeImage(imageToRefine.file, feedback, id);
        
        setImages(prev => prev.map(img => {
            if (img.id !== id) return img;
            return {
                ...img, 
                status: 'success',
                result: result.analysis,
                heatmapImageUrl: `data:image/jpeg;base64,${result.heatmapImageBase64}`,
                error: undefined
            };
        }));
    } catch (err) {
        setImages(prev => prev.map(img =>
            img.id === id ? { ...img, status: 'error', error: (err as Error).message } : img
        ));
    }
  }, [images]);

  const handleDeleteImage = (id: string) => {
    setImages(prev => {
        const imageToDelete = prev.find(img => img.id === id);
        if (imageToDelete) URL.revokeObjectURL(imageToDelete.previewUrl);
        return prev.filter(img => img.id !== id);
    });
  };
  
  const pendingCount = useMemo(() => images.filter(i => i.status === 'pending').length, [images]);
  const failedCount = useMemo(() => images.filter(i => i.status === 'error').length, [images]);

  return (
    <div className="min-h-screen bg-slate-900 font-sans">
      <Header />
      <main className="container mx-auto p-4 md:p-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <aside className="lg:col-span-4 xl:col-span-3">
            <div className="sticky top-8 bg-slate-800 rounded-2xl p-6 shadow-2xl shadow-slate-950/50 border border-slate-700">
              <h2 className="text-xl font-semibold mb-4 text-cyan-400">Control Panel</h2>
              <ImageUploader onImageUpload={handleImageUpload} />
              {images.length > 0 && (
                <div className="mt-4 flex items-center text-sm text-green-400 bg-green-900/50 p-3 rounded-lg">
                    <CheckCircleIcon className="w-5 h-5 mr-2 flex-shrink-0"/>
                    <span className="truncate">{images.length} image{images.length > 1 ? 's' : ''} loaded</span>
                </div>
              )}
              <button
                onClick={handleAnalyzeAll}
                disabled={pendingCount === 0 || isAnalyzing}
                className="w-full mt-4 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-bold py-3 px-4 rounded-lg transition-all duration-300 hover:scale-105"
              >
                {isAnalyzing ? 'Analyzing...' : `Analyze ${pendingCount} Pending`}
              </button>

              {failedCount > 0 && (
                 <button onClick={handleRetryFailed} disabled={isAnalyzing} className="w-full mt-4 flex items-center justify-center gap-2 bg-red-600/20 hover:bg-red-600/30 text-red-400 border border-red-500/50 font-bold py-3 px-4 rounded-lg">
                    <RefreshIcon className="w-5 h-5" />
                    Retry {failedCount} Failed
                  </button>
              )}
            </div>
          </aside>

          <div className="lg:col-span-8 xl:col-span-9">
            <div className="grid grid-cols-1 gap-8">
                {images.length === 0 && (
                    <div className="text-center p-8 border-2 border-dashed border-slate-600 rounded-2xl bg-slate-800/50">
                      <div className="flex justify-center mb-4"><div className="p-4 bg-slate-700 rounded-full"><UploadIcon className="w-8 h-8 text-cyan-400" /></div></div>
                      <h2 className="text-2xl font-bold text-slate-100 mb-2">Upload Retinal OCT Images</h2>
                      <p className="text-slate-400">Batch analysis ready. Images are locally hashed for verification.</p>
                    </div>
                )}
                {images.map(image => (
                    <AnalysisResults
                        key={image.id}
                        imageState={image}
                        onRefine={handleRefineAnalysis}
                        onDelete={handleDeleteImage}
                    />
                ))}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;
