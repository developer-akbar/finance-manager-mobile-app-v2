/**
 * src/components/AskFinMan/SafeMarkdown.jsx
 *
 * Lightweight, safe markdown formatter for AI assistant responses.
 * Renders headers, bullet points, bold/italic, code blocks, and line breaks
 * without external dependency overhead or dangerouslySetInnerHTML risks.
 */

import React from 'react';

export default function SafeMarkdown({ content = '' }) {
  if (!content || typeof content !== 'string') return null;

  const lines = content.split('\n');
  const elements = [];
  let inCodeBlock = false;
  let codeBlockLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        elements.push(
          <pre key={`code_${i}`} className="ai-code-block">
            <code>{codeBlockLines.join('\n')}</code>
          </pre>
        );
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockLines.push(line);
      continue;
    }

    if (!line.trim()) {
      elements.push(<div key={`sp_${i}`} className="ai-spacer" />);
      continue;
    }

    // Headers
    if (line.startsWith('### ')) {
      elements.push(<h4 key={`h4_${i}`} className="ai-h4">{renderInline(line.slice(4))}</h4>);
      continue;
    }
    if (line.startsWith('#### ')) {
      elements.push(<h5 key={`h5_${i}`} className="ai-h5">{renderInline(line.slice(5))}</h5>);
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(<h3 key={`h3_${i}`} className="ai-h3">{renderInline(line.slice(3))}</h3>);
      continue;
    }

    // Horizontal Rule
    if (line.trim() === '---' || line.trim() === '***') {
      elements.push(<hr key={`hr_${i}`} className="ai-hr" />);
      continue;
    }

    // Bullet items
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const bulletText = line.trim().slice(2);
      elements.push(
        <div key={`li_${i}`} className="ai-bullet-item">
          <span className="ai-bullet-dot">•</span>
          <span className="ai-bullet-text">{renderInline(bulletText)}</span>
        </div>
      );
      continue;
    }

    // Numbered items
    const numberedMatch = line.trim().match(/^(\d+)\.\s+(.*)$/);
    if (numberedMatch) {
      elements.push(
        <div key={`num_${i}`} className="ai-numbered-item">
          <span className="ai-num-prefix">{numberedMatch[1]}.</span>
          <span className="ai-num-text">{renderInline(numberedMatch[2])}</span>
        </div>
      );
      continue;
    }

    // Normal paragraph
    elements.push(
      <p key={`p_${i}`} className="ai-paragraph">
        {renderInline(line)}
      </p>
    );
  }

  return <div className="safe-markdown-container">{elements}</div>;
}

function renderInline(text) {
  if (!text) return null;

  // Split bold (**text**)
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      const boldContent = part.slice(2, -2);
      return <strong key={idx} className="ai-bold">{renderCode(boldContent)}</strong>;
    }
    return renderCode(part, idx);
  });
}

function renderCode(text, baseKey = 0) {
  if (typeof text !== 'string') return text;
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={`${baseKey}_code_${idx}`} className="ai-inline-code">{part.slice(1, -1)}</code>;
    }
    return part;
  });
}

