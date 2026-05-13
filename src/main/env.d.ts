// electron-vite ?asset query: resolves to a path string at runtime (dev =
// absolute path on disk, packaged = path inside the app's resources).
declare module '*?asset' {
  const src: string
  export default src
}
