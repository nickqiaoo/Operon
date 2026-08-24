import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router'
import './index.css'
import { ImageZoomProvider } from './components/ImageZoom.tsx'
import App from './App.tsx'
import { Privacy } from './pages/Privacy.tsx'
import { Terms } from './pages/Terms.tsx'
import { Docs } from './pages/Docs.tsx'
import { Support } from './pages/Support.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ImageZoomProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/support" element={<Support />} />
      </Routes>
    </BrowserRouter>
    </ImageZoomProvider>
  </StrictMode>,
)
