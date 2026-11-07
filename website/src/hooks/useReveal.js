import { useEffect, useRef } from "react";

export function useReveal() {
  const node = useRef(null);

  useEffect(() => {
    const element = node.current;
    if (!element) return undefined;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.dataset.revealed = "true";
      return undefined;
    }
    element.dataset.revealed = "false";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        element.dataset.revealed = "true";
        observer.disconnect();
      },
      { threshold: 0.12 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return node;
}
