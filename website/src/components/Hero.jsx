import { ArrowDownRight, ArrowUpRight, BookmarkSimple, Check } from "@phosphor-icons/react";
import { SubtitleDemo } from "./SubtitleDemo.jsx";

export function Hero() {
  return (
    <section className="hero" id="top" aria-labelledby="hero-title">
      <img
        className="hero-media"
        src={`${import.meta.env.BASE_URL}assets/youtube-hero-clean.jpg`}
        alt="Trace 英语教学视频字幕使用场景"
        fetchPriority="high"
      />
      <div className="hero-shade" />
      <div className="hero-grain" />

      <div className="hero-shell">
        <div className="hero-copy">
          <p className="hero-kicker">
            <span className="live-dot" aria-hidden="true" />
            免费 · 开源 · 本地保存
          </p>
          <h1 id="hero-title">
            看视频，
            <br />
            也在记住英语。
          </h1>
          <p className="hero-description">
            双语字幕、点词查义、跨视频生词复习。都在你正在看的视频里。
          </p>
          <div className="hero-actions">
            <a className="button button-light" href="#install">
              安装 Chrome 扩展
              <ArrowUpRight size={18} weight="bold" />
            </a>
            <a className="text-link" href="#features">
              看看怎么用
              <ArrowDownRight size={17} weight="bold" />
            </a>
          </div>
        </div>
      </div>

      <div className="hero-subtitle-layer">
        <SubtitleDemo immersive />
      </div>

      <div className="hero-bottomline">
        <div className="hero-fact">
          <BookmarkSimple size={18} weight="light" />
          <span>生词跟着你，跨视频自动高亮</span>
        </div>
        <div className="hero-fact">
          <Check size={18} weight="bold" />
          <span>无需注册，不收集学习数据</span>
        </div>
        <div className="hero-fact">
          <span className="fact-mono">EN</span>
          <ArrowUpRight size={13} />
          <span>YouTube 英文视频</span>
        </div>
      </div>
    </section>
  );
}
