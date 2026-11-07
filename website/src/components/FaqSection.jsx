import { Minus, Plus } from "@phosphor-icons/react";
import { useState } from "react";
import { faqs } from "../data.js";

export function FaqSection() {
  const [openIndex, setOpenIndex] = useState(0);

  return (
    <section className="faq-section section-shell" id="faq" aria-labelledby="faq-title">
      <div className="faq-intro">
        <h2 id="faq-title">你可能还想知道</h2>
        <p>关于账号、数据和翻译引擎，这里先回答清楚。</p>
      </div>
      <div className="faq-list">
        {faqs.map((item, index) => {
          const isOpen = openIndex === index;
          return (
            <article className={`faq-item ${isOpen ? "is-open" : ""}`} key={item.question}>
              <button
                type="button"
                className="faq-question"
                aria-expanded={isOpen}
                aria-controls={`faq-answer-${index}`}
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
              >
                <span>{item.question}</span>
                {isOpen ? <Minus size={19} /> : <Plus size={19} />}
              </button>
              <div id={`faq-answer-${index}`} className="faq-answer" hidden={!isOpen}>
                <p>{item.answer}</p>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
