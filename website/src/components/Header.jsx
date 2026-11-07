import { List, X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Logo } from "./Logo.jsx";

const GITHUB_URL = "https://github.com/Gavin-gwj/trace-subtitles";

export function Header() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const sentinelRef = useRef(null);

  useEffect(() => {
    function closeOnEscape(event) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, []);

  useEffect(() => {
    if (!sentinelRef.current) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setScrolled(!entry.isIntersecting),
      { threshold: 0 },
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <div ref={sentinelRef} className="nav-sentinel" aria-hidden="true" />
      <header className={`site-header ${scrolled ? "is-scrolled" : ""}`}>
        <div className="nav-shell">
          <Logo compact />
          <nav className="desktop-nav" aria-label="主导航">
            <a href="#features">功能</a>
            <a href="#wordbook">生词本</a>
            <a href="#install">安装</a>
            <a href="#faq">常见问题</a>
          </nav>
          <div className="nav-actions">
            <a
              className="source-link"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
            <a className="button button-light nav-cta" href="#install">
              安装扩展
            </a>
          </div>
          <button
            type="button"
            className="menu-toggle"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="mobile-nav"
            aria-label={open ? "关闭菜单" : "打开菜单"}
          >
            {open ? <X size={22} /> : <List size={22} />}
          </button>
        </div>

        <nav id="mobile-nav" className={`mobile-nav ${open ? "is-open" : ""}`} aria-label="移动端导航">
          <a href="#features" onClick={() => setOpen(false)}>功能</a>
          <a href="#wordbook" onClick={() => setOpen(false)}>生词本</a>
          <a href="#install" onClick={() => setOpen(false)}>安装</a>
          <a href="#faq" onClick={() => setOpen(false)}>常见问题</a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}>
            GitHub
          </a>
          <a className="button button-light" href="#install" onClick={() => setOpen(false)}>
            安装扩展
          </a>
        </nav>
      </header>
    </>
  );
}
