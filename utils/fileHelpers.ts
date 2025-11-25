
export const generateFileHash = async (file: File): Promise<string> => {
  if (typeof window === 'undefined' || !window.crypto || !window.crypto.subtle) {
    return `${file.name}-${file.size}-${file.lastModified}`; // Fallback for non-secure contexts
  }
  const buffer = await file.arrayBuffer();
  const hashBuffer = await window.crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
};

export const debugRequest = async (file: File, id: string) => {
  const hash = await generateFileHash(file);
  const debugInfo = {
    id,
    name: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
    hash,
    timestamp: new Date().toISOString(),
  };
  console.groupCollapsed(`[Request Debug] ${file.name}`);
  console.table(debugInfo);
  console.groupEnd();
  return debugInfo;
};
