import { ArrowUpRight, BookmarkSimple, Check, TextAa } from "@phosphor-icons/react";
import { useReveal } from "../hooks/useReveal.js";
import { featureRows } from "../data.js";

function FeatureVisual({ type }) {
  if (type === "subtitles") {
    return (
      <div className="feature-visual visual-subtitles" aria-hidden="true">
        <div className="visual-window-bar">
          <span>TRACE / BILINGUAL</span>
          <span className="visual-mini-control">AUTO</span>
        </div>
        <div className="visual-video-frame">
          <div className="visual-video-lines">
            <span />
            <span />
            <span />
          </div>
          <div className="visual-caption-stack">
            <p>The first step is to capture the subtitle tracks.</p>
            <p>第一步，是获取完整的字幕轨道。</p>
          </div>
        </div>
        <div className="visual-options">
          <span>简洁</span>
          <span className="is-active">标准</span>
          <span>详细</span>
          <TextAa size={17} />
        </div>
      </div>
    );
  }

  if (type === "lookup") {
    return (
      <div className="feature-visual visual-lookup" aria-hidden="true">
        <div className="lookup-sentence">
          Good ideas often <mark>settle</mark> in the background.
        </div>
        <div className="lookup-translation">好想法常常在背景里慢慢成形。</div>
        <div className="lookup-card">
          <div className="lookup-head">
            <strong>settle</strong>
            <span>/ˈsetl/</span>
          </div>
          <div className="lookup-tag">动词</div>
          <p>1. 逐渐形成；稳定下来</p>
          <p>2. 在某个位置安顿</p>
          <div className="lookup-context">
            <span>本句</span>
            settle in the background
          </div>
          <button type="button" tabIndex="-1">
            <BookmarkSimple size={14} />
            加入生词本
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="feature-visual visual-reminder" aria-hidden="true">
      <div className="reminder-list">
        <div className="reminder-row is-focus">
          <div>
            <strong>retain</strong>
            <span>保留；记住</span>
          </div>
          <span className="memory-pill">模糊</span>
        </div>
        <div className="reminder-row">
          <div>
            <strong>context</strong>
            <span>语境；上下文</span>
          </div>
          <span className="memory-pill">已记住</span>
        </div>
        <div className="reminder-row">
          <div>
            <strong>subtle</strong>
            <span>微妙的</span>
          </div>
          <span className="memory-pill is-new">新词</span>
        </div>
      </div>
      <div className="reminder-status">
        <div>
          <span className="status-icon"><Check size={14} weight="bold" /></span>
          <span>这个词在 3 个视频里出现</span>
        </div>
        <ArrowUpRight size={16} />
      </div>
    </div>
  );
}

export function FeatureRows() {
  const reveal = useReveal();
  return (
    <section className="feature-section section-shell" id="features" aria-labelledby="features-title">
      <div className="section-intro">
        <h2 id="features-title">不用多开一个 App。</h2>
        <p>
          学习发生在你原本要看的视频里。少一次切换，就多一点专注。
        </p>
      </div>

      <div className="feature-list">
        {featureRows.map((feature) => (
          <article className="feature-row reveal" ref={reveal} key={feature.number}>
            <div className="feature-copy">
              <span className="feature-number">{feature.number}</span>
              <h3>{feature.title}</h3>
              <p className="feature-lead">{feature.lead}</p>
              <p className="feature-body">{feature.body}</p>
              <p className="feature-detail">{feature.detail}</p>
            </div>
            <FeatureVisual type={feature.visual} />
          </article>
        ))}
      </div>
    </section>
  );
}
