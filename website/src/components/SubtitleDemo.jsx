import { ArrowRight, BookmarkSimple, Check, SpeakerHigh } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { subtitleLines, wordDefinitions } from "../data.js";

function Word({ part, onSelect, selected }) {
  if (!part.word) {
    return <span className={part.className || ""}>{part.text}</span>;
  }

  return (
    <button
      className={`inline-word ${part.className || ""} ${selected === part.word ? "is-selected" : ""}`}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onSelect(part.word);
      }}
      aria-label={`查看 ${part.word} 的释义`}
    >
      {part.text}
    </button>
  );
}

export function SubtitleDemo({ paused = false, compact = false, immersive = false }) {
  const [lineIndex, setLineIndex] = useState(0);
  const [selectedWord, setSelectedWord] = useState("stay");
  const [saved, setSaved] = useState(new Set(["again"]));
  const [known, setKnown] = useState(new Set());
  const [originalOpen, setOriginalOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [isPlaying, setIsPlaying] = useState(!paused);
  const resumeTimer = useRef(null);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const timer = window.setInterval(() => {
      setLineIndex((current) => (current + 1) % subtitleLines.length);
    }, 5600);
    return () => window.clearInterval(timer);
  }, [isPlaying]);

  useEffect(
    () => () => {
      if (resumeTimer.current) window.clearTimeout(resumeTimer.current);
    },
    [],
  );

  const current = subtitleLines[lineIndex];
  const definition = wordDefinitions[selectedWord] || wordDefinitions.stay;

  function pauseBriefly(duration = 9000) {
    setIsPlaying(false);
    if (resumeTimer.current) window.clearTimeout(resumeTimer.current);
    resumeTimer.current = window.setTimeout(() => setIsPlaying(true), duration);
  }

  function chooseWord(word) {
    setSelectedWord(word);
    setRevealed(false);
    setOriginalOpen(false);
    pauseBriefly();
  }

  function toggleSave() {
    setSaved((previous) => {
      const next = new Set(previous);
      if (next.has(selectedWord)) next.delete(selectedWord);
      else next.add(selectedWord);
      return next;
    });
  }

  function toggleKnown() {
    setKnown((previous) => {
      const next = new Set(previous);
      if (next.has(selectedWord)) next.delete(selectedWord);
      else next.add(selectedWord);
      return next;
    });
  }

  const isSaved = saved.has(selectedWord);
  const isKnown = known.has(selectedWord);

  return (
    <div
      className={`caption-demo ${compact ? "is-compact" : ""} ${immersive ? "is-immersive" : ""}`}
      aria-label="Trace 双语字幕互动演示"
    >
      <div className="demo-toolbar">
        <div className="demo-status">
          <span className="playback-mark" data-active={isPlaying} />
          <span>{isPlaying ? "自动跟随视频" : "已暂停，查词中"}</span>
        </div>
        <div className="demo-actions">
          <button
            type="button"
            className="icon-button"
            onClick={() => {
              setLineIndex((lineIndex + 1) % subtitleLines.length);
              setRevealed(false);
              pauseBriefly();
            }}
            aria-label="切换下一句字幕"
            title="下一句"
          >
            <ArrowRight size={16} weight="bold" />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setIsPlaying((value) => !value)}
            aria-label={isPlaying ? "暂停字幕" : "继续字幕"}
            title={isPlaying ? "暂停" : "继续"}
          >
            <span className={`mini-play ${isPlaying ? "is-pause" : ""}`} aria-hidden="true">
              {isPlaying ? "Ⅱ" : "▶"}
            </span>
          </button>
        </div>
      </div>

      <div className="caption-stage" onClick={() => setRevealed(false)}>
        <div className="caption-copy" key={lineIndex}>
          <p className="caption-line">
            {current.en.map((part, index) => (
              <Word
                key={`${part.text}-${index}`}
                part={part}
                onSelect={chooseWord}
                selected={selectedWord}
              />
            ))}
          </p>
          <p className="caption-translation">{current.zh}</p>
        </div>

        {!revealed && (
          <div
            className={`dictionary-popover ${compact ? "is-compact" : ""} ${immersive ? "is-immersive" : ""}`}
            aria-live="polite"
          >
            <div className="dictionary-head">
              <span className="dictionary-word">{definition.word}</span>
              <span className="dictionary-phonetic">{definition.phonetic}</span>
              <button
                type="button"
                className="dictionary-close"
                onClick={() => setRevealed(true)}
                aria-label="收起释义"
              >
                ×
              </button>
            </div>
            {immersive ? (
              <>
                <div className="dictionary-gloss">
                  <span>单词直译</span>
                  <p>
                    <span className="dictionary-pos">{definition.partOfSpeech}</span>
                    {definition.gloss}
                  </p>
                </div>
                <div className="dictionary-translation-block">
                  <span>本句译文</span>
                  <p className="dictionary-source">{current.en.map((part) => part.text).join("")}</p>
                  <p className="dictionary-target">{current.zh}</p>
                </div>
                <button
                  className={`dictionary-original ${originalOpen ? "is-open" : ""}`}
                  type="button"
                  aria-expanded={originalOpen}
                  onClick={() => setOriginalOpen((value) => !value)}
                >
                  <span aria-hidden="true">{originalOpen ? "−" : "+"}</span>
                  <span>英文原文释义</span>
                </button>
                {originalOpen && (
                  <p className="dictionary-original-copy">{definition.original}</p>
                )}
              </>
            ) : (
              <>
                <p className="dictionary-meaning">{definition.meaning}</p>
                <p className="dictionary-context">{definition.context}</p>
                <p className="dictionary-zh">{definition.contextZh}</p>
                <div className="dictionary-divider" />
              </>
            )}
            <button
              className={`save-word ${isSaved ? "is-saved" : ""}`}
              type="button"
              onClick={toggleSave}
            >
              {isSaved ? (
                <Check size={15} weight="bold" />
              ) : (
                <BookmarkSimple size={15} weight="bold" />
              )}
              {isSaved ? "已在生词本" : "加入生词本"}
            </button>
            {immersive && (
              <button
                className={`remember-word ${isKnown ? "is-known" : ""}`}
                type="button"
                onClick={toggleKnown}
              >
                {isKnown ? "已记住" : "标记为「已经记住」"}
              </button>
            )}
            {!immersive && (
              <div className="dictionary-footer">
                <SpeakerHigh size={14} aria-hidden="true" />
                <span>慢速发音</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="demo-pagination" aria-label="字幕演示进度">
        {subtitleLines.map((line, index) => (
          <button
            type="button"
            key={line.offset}
            className={index === lineIndex ? "is-current" : ""}
            onClick={() => {
              setLineIndex(index);
              setRevealed(false);
            }}
            aria-label={`查看第 ${index + 1} 句`}
          />
        ))}
      </div>
    </div>
  );
}
