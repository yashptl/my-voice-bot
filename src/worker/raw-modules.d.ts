/** Vite's `?raw` import: the file's text, bundled into the Worker. */
declare module "*?raw" {
  const text: string;
  export default text;
}
