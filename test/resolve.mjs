const STUBS = {
  'next/link': new URL('./stubs/next-link.tsx', import.meta.url).href,
};

export async function resolve(specifier, context, nextResolve) {
  return specifier in STUBS ? { url: STUBS[specifier], shortCircuit: true } : nextResolve(specifier, context);
}
