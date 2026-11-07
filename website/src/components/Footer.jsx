import { ArrowUpRight, GithubLogo } from "@phosphor-icons/react";
import { Logo } from "./Logo.jsx";

const GITHUB_URL = "https://github.com/Gavin-gwj/trace-subtitles";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="footer-shell">
        <div className="footer-main">
          <div className="footer-statement">
            <span className="footer-mark" aria-hidden="true">T</span>
            <h2>把看过的，留下来。</h2>
            <a className="button button-light" href="#install">
              安装 Trace
              <ArrowUpRight size={18} weight="bold" />
            </a>
          </div>
          <div className="footer-links">
            <div>
              <span className="footer-label">产品</span>
              <a href="#features">字幕与查词</a>
              <a href="#wordbook">生词复习</a>
              <a href="#install">安装扩展</a>
            </div>
            <div>
              <span className="footer-label">开源</span>
              <a href={GITHUB_URL} target="_blank" rel="noreferrer">
                GitHub
                <ArrowUpRight size={13} />
              </a>
              <a href={`${GITHUB_URL}#readme`} target="_blank" rel="noreferrer">
                使用说明
              </a>
              <a href={`${GITHUB_URL}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
                MIT License
              </a>
            </div>
          </div>
        </div>
        <div className="footer-bottom">
          <Logo compact />
          <p>免费开源 · 不需要登录 · 数据留在本地</p>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer" aria-label="Trace GitHub 仓库">
            <GithubLogo size={20} />
          </a>
        </div>
      </div>
    </footer>
  );
}
