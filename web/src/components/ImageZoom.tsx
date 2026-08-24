import React, { createContext, useContext, useState, useCallback } from "react";

interface ImageZoomState {
  src: string | null;
  alt: string;
}

interface ImageZoomContextValue {
  open: (src: string, alt?: string) => void;
  close: () => void;
}

const ImageZoomContext = createContext<ImageZoomContextValue | null>(null);

function useImageZoom(): ImageZoomContextValue {
  const ctx = useContext(ImageZoomContext);
  if (!ctx) {
    throw new Error("useImageZoom must be used within an ImageZoomProvider");
  }
  return ctx;
}

export function ImageZoomProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ImageZoomState>({ src: null, alt: "" });
  const [visible, setVisible] = useState(false);

  const open = useCallback((src: string, alt = "") => {
    setState({ src, alt });
    // Trigger fade-in on next frame
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    // Wait for fade-out transition before clearing src
    setTimeout(() => setState({ src: null, alt: "" }), 200);
  }, []);

  return (
    <ImageZoomContext.Provider value={{ open, close }}>
      {children}
      {state.src && (
        <div
          onClick={close}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.9)",
            cursor: "zoom-out",
            opacity: visible ? 1 : 0,
            transition: "opacity 0.2s ease-in-out",
          }}
        >
          <img
            src={state.src}
            alt={state.alt}
            style={{
              maxWidth: "90vw",
              maxHeight: "90vh",
              objectFit: "contain",
              borderRadius: 4,
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          />
        </div>
      )}
    </ImageZoomContext.Provider>
  );
}

type ZoomableImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
  zoomSrc?: string;
};

export function ZoomableImage({
  zoomSrc,
  src,
  alt,
  style,
  ...rest
}: ZoomableImageProps) {
  const { open } = useImageZoom();

  const handleClick = useCallback(() => {
    const target = zoomSrc || src;
    if (target) {
      open(target, alt);
    }
  }, [zoomSrc, src, alt, open]);

  return (
    <img
      src={src}
      alt={alt}
      onClick={handleClick}
      style={{ cursor: "zoom-in", ...style }}
      {...rest}
    />
  );
}
