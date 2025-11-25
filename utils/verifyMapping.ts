
import { AnalyzableImage, AnalysisResult } from '../types';
import { generateFileHash } from './fileHelpers';

export const verifyMapping = async (
  image: AnalyzableImage,
  resultId: string | undefined,
  backendHash: string | undefined
): Promise<boolean> => {
  // 1. Verify ID Match
  if (resultId && resultId !== image.id) {
    console.error(`[Mapping Error] ID Mismatch! Expected ${image.id}, got ${resultId}`);
    return false;
  }

  // 2. Verify Content Hash (if supported by backend)
  if (backendHash) {
    const localHash = await generateFileHash(image.file);
    if (localHash !== backendHash) {
      console.error(`[Mapping Error] Hash Mismatch! File changed or wrong file processed.`);
      console.error(`Local: ${localHash} | Remote: ${backendHash}`);
      return false;
    }
  }

  console.log(`[Mapping Verified] Image ${image.id.slice(0, 8)} matches result.`);
  return true;
};
