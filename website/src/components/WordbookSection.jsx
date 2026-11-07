import {
  ArrowUpRight,
  CheckCircle,
  Circle,
  Clock,
  Eye,
  EyeSlash,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useState } from "react";
import { glossary, reviewWords } from "../data.js";
import { useReveal } from "../hooks/useReveal.js";

export function WordbookSection() {
  const [revealed, setRevealed] = useState(true);
  const [activeFilter, setActiveFilter] = useState("全部");
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const reveal = useReveal();

  const filteredWords =
    activeFilter === "复习中"
      ? reviewWords.filter((word) => word.status === "review")
      : activeFilter === "已记住"
        ? reviewWords.filter((word) => word.status === "known")
        : reviewWords;
  const visibleWords = query
    ? filteredWords.filter((word) => word.word.toLowerCase().includes(query.toLowerCase()))
    : filteredWords;

  return (
    <section className="wordbook-section" id="wordbook" aria-labelledby="wordbook-title">
      <div className="section-shell">
        <div className="wordbook-heading">
          <h2 id="wordbook-title">复习，不用重新整理一遍。</h2>
          <p>
            收藏时已经带着原句。下次遇见，模糊提示先帮你回想，再决定是否揭开答案。
          </p>
        </div>

        <div className="wordbook-stage reveal" ref={reveal}>
          <div className="wordbook-photo">
            <img
              src={`${import.meta.env.BASE_URL}assets/study-room-still.jpg`}
              alt="夜间在书桌前学习的人"
              loading="eager"
              fetchPriority="low"
            />
            <div className="photo-caption">
              <span className="photo-caption-label">YOUR WORDS</span>
              <span>在你自己的轨迹里回来</span>
            </div>
          </div>

          <div className="wordbook-panel">
            <div className="panel-header">
              <div>
                <span className="panel-title">我的生词本</span>
                <span className="panel-count">{reviewWords.length} 个词，等你回来</span>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="搜索生词"
                onClick={() => setShowSearch((value) => !value)}
                aria-expanded={showSearch}
              >
                <MagnifyingGlass size={18} />
              </button>
            </div>

            {showSearch && (
              <label className="word-search">
                <span className="sr-only">搜索生词</span>
                <MagnifyingGlass size={15} aria-hidden="true" />
                <input
                  type="search"
                  placeholder="搜索单词或释义"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  autoFocus
                />
              </label>
            )}

            <div className="panel-status-row">
              <span>
                <Circle size={8} weight="fill" className="status-red" />
                3 个需要复习
              </span>
              <span>
                <CheckCircle size={15} weight="fill" className="status-green" />
                2 个已经记住
              </span>
            </div>

            <div className="filter-tabs" role="tablist" aria-label="生词筛选">
              {["全部", "复习中", "已记住"].map((filter) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeFilter === filter}
                  key={filter}
                  className={activeFilter === filter ? "is-active" : ""}
                  onClick={() => setActiveFilter(filter)}
                >
                  {filter}
                </button>
              ))}
            </div>

            <div className="word-list" aria-live="polite">
              {visibleWords.map((item) => (
                <div className="word-row" key={item.word}>
                  <div className="word-main">
                    <strong>{item.word}</strong>
                    <span>{item.phonetic}</span>
                  </div>
                  <span className={`word-memory ${item.status}`}>{item.memory}</span>
                  <span className="word-age">
                    <Clock size={13} />
                    {item.age}
                  </span>
                </div>
              ))}
              {!visibleWords.length && (
                <div className="empty-filter">
                  {query ? "没有找到这个词，换个拼写试试。" : "这个分类里还没有词，去视频里选中一个吧。"}
                </div>
              )}
            </div>

            <div className="panel-footer">
              <span>学习进度保存在本机</span>
              <a href="#install">
                回到视频
                <ArrowUpRight size={14} />
              </a>
            </div>
          </div>
        </div>

        <div className="review-board">
          <div className="review-board-copy">
            <h3>先回想，再揭开。</h3>
            <p>出现过的词会自动模糊中文释义。盯得够久或打开卡片，就算一次复习。</p>
            <button
              type="button"
              className="text-link"
              onClick={() => setRevealed((value) => !value)}
              aria-pressed={revealed}
            >
              {revealed ? <EyeSlash size={18} /> : <Eye size={18} />}
              {revealed ? "收起答案，进入复习" : "揭开答案"}
            </button>
          </div>
          <div className={`glossary-sample ${revealed ? "" : "is-masked"}`}>
            {glossary.map((item) => (
              <div className="glossary-card" key={item.word}>
                <div>
                  <strong>{item.word}</strong>
                  <span>{item.status === "known" ? "已记住" : item.status === "new" ? "新词" : "复习中"}</span>
                </div>
                <p>{item.meaning}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
