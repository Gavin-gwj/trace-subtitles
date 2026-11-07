import { ArrowUpRight, Check, GithubLogo, ShieldCheck, WifiSlash } from "@phosphor-icons/react";
import { installSteps } from "../data.js";

const GITHUB_URL = "https://github.com/Gavin-gwj/trace-subtitles";

export function InstallSection() {
  return (
    <section className="install-section section-shell" id="install" aria-labelledby="install-title">
      <div className="install-lead">
        <span className="install-mark" aria-hidden="true">T</span>
        <div>
          <h2 id="install-title">三分钟，装在你的 Chrome 里。</h2>
          <p>
            免费开源。不用注册，不用填 API Key。字幕和生词都留在自己的电脑上。
          </p>
          <div className="install-actions">
            <a
              className="button button-light"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              获取安装文件
              <ArrowUpRight size={18} weight="bold" />
            </a>
            <a
              className="text-link"
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
            >
              <GithubLogo size={18} weight="fill" />
              在 GitHub 查看源码
            </a>
          </div>
        </div>
      </div>

      <div className="install-steps">
        {installSteps.map((step, index) => (
          <article className="install-step" key={step.title}>
            <span className="step-index">{String(index + 1).padStart(2, "0")}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </article>
        ))}
      </div>

      <div className="install-assurances">
        <div>
          <ShieldCheck size={21} weight="light" />
          <span>
            <strong>本地优先</strong>
            不收集学习数据
          </span>
        </div>
        <div>
          <WifiSlash size={21} weight="light" />
          <span>
            <strong>可离线验证</strong>
            带测试播放器
          </span>
        </div>
        <div>
          <Check size={21} weight="bold" />
          <span>
            <strong>默认即用</strong>
            不配置也能翻译
          </span>
        </div>
      </div>
    </section>
  );
}
