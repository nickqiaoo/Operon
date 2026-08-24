# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

## Cloudflare Download Redirect

The website download buttons now point to `/download` instead of the GitHub Releases page directly.

At runtime, Cloudflare Pages Functions resolves the correct release asset and redirects the visitor to the matching GitHub download URL. This lets you switch versions without redeploying the web app.

This setup assumes your Cloudflare Pages project root is `web`, so the function files live under `web/functions`.

### Setup

1. Create a KV namespace and bind it as `DOWNLOAD_CONFIG_KV`.
2. Put the JSON from [doc/download-config.example.json](./doc/download-config.example.json) into the key `download:stable`.
3. Keep release assets on GitHub Releases with stable filenames.

### Example config

```json
{
  "version": "1.0.0-beta.4",
  "github": {
    "owner": "Nickqiaoo",
    "repo": "Operon",
    "tagPrefix": "v"
  },
  "files": {
    "mac-arm64": "Operon-1.0.0-beta.4-arm64.dmg",
    "mac-x64": "Operon-1.0.0-beta.4-x64.dmg",
    "windows-x64": "Operon-Setup-1.0.0-beta.4.exe"
  },
  "fallbacks": {
    "mac": "mac-arm64",
    "windows": "windows-x64"
  },
  "defaultTarget": "mac-arm64"
}
```

### Notes

- Chromium browsers can provide more accurate architecture hints.
- Safari may not expose CPU architecture, so the function falls back to the platform defaults in the config.
- If no exact match is found, the function falls back to the GitHub Releases page.

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
