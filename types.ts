
export interface AnalysisResult {
  diagnosis: 'CNV' | 'DME' | 'Drusen' | 'Normal' | 'AMD' | 'Geographic Atrophy' | 'Requires Further Review';
  confidence: string;
  explanation: string;
  explainability: string;
  uncertaintyStatement: string;
  segmentationUncertaintyStatement: string;
  anomalyReport?: string;
  // Metadata for verification
  processedId?: string;
  processedHash?: string;
  timestampBackend?: string;
}

export type ImageStatus = 'pending' | 'loading' | 'success' | 'error';
export type MappingStatus = 'unverified' | 'verified' | 'mismatch';

export interface AnalyzableImage {
  id: string;
  file: File;
  hash?: string; // SHA-256 hash for integrity
  previewUrl: string;
  status: ImageStatus;
  mappingStatus: MappingStatus;
  result?: AnalysisResult;
  error?: string;
  segmentedImageUrl?: string;
  heatmapImageUrl?: string;
  segmentationUncertaintyMapUrl?: string;
}
