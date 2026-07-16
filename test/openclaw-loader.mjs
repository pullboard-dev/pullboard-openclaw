const ENTRY = "openclaw/plugin-sdk/plugin-entry";
const STUB = "data:text/javascript,export const definePluginEntry=(entry)=>entry";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === ENTRY) return { url: STUB, shortCircuit: true };
  return nextResolve(specifier, context);
}
