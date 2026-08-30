import { useMemo, type ReactNode } from "react";

interface MarkdownPreviewProps {
  content: string;
  className?: string;
}

function renderInline(text: string): ReactNode[] {
  const elements: ReactNode[] = [];
  // Tokenize inline markdown: code, links, bold, italic
  let remaining = text;
  let keyIndex = 0;

  while (remaining.length > 0) {
    // 1. Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch && codeMatch.index === 0) {
      elements.push(
        <code key={`code-${keyIndex++}`} className="md-inline-code">
          {codeMatch[1]}
        </code>
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // 2. Links: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch.index === 0) {
      const href = linkMatch[2];
      const safeHref = href.startsWith("http://") || href.startsWith("https://") || href.startsWith("#") ? href : "#";
      elements.push(
        <a
          key={`link-${keyIndex++}`}
          href={safeHref}
          target="_blank"
          rel="noreferrer noopener"
          className="md-link"
        >
          {linkMatch[1]}
        </a>
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // 3. Bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch && boldMatch.index === 0) {
      elements.push(
        <strong key={`bold-${keyIndex++}`}>
          {renderInline(boldMatch[2])}
        </strong>
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // 4. Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)(.+?)\1/);
    if (italicMatch && italicMatch.index === 0) {
      elements.push(
        <em key={`italic-${keyIndex++}`}>
          {renderInline(italicMatch[2])}
        </em>
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Plain text up to next potential inline token
    const nextSpecial = remaining.search(/[`\[\*_]/);
    if (nextSpecial === -1) {
      elements.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Unmatched delimiter character
      elements.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      elements.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return elements;
}

export default function MarkdownPreview({ content, className = "" }: MarkdownPreviewProps) {
  const renderedNodes = useMemo(() => {
    if (!content || !content.trim()) {
      return <p className="md-empty-text"><em>No content provided.</em></p>;
    }

    const lines = content.split("\n");
    const blocks: ReactNode[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Empty line
      if (!trimmed) {
        i++;
        continue;
      }

      // Fenced code block: ```[lang]
      if (trimmed.startsWith("```")) {
        const lang = trimmed.slice(3).trim();
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // consume closing ```
        blocks.push(
          <div key={`code-block-${i}`} className="md-code-block-wrap">
            {lang && <div className="md-code-lang">{lang}</div>}
            <pre className="md-code-block">
              <code>{codeLines.join("\n")}</code>
            </pre>
          </div>
        );
        continue;
      }

      // Headers: # ... ######
      const headerMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (headerMatch) {
        const level = headerMatch[1].length;
        const text = headerMatch[2];
        const inline = renderInline(text);
        if (level === 1) blocks.push(<h1 key={`h1-${i}`} className="md-h1">{inline}</h1>);
        else if (level === 2) blocks.push(<h2 key={`h2-${i}`} className="md-h2">{inline}</h2>);
        else if (level === 3) blocks.push(<h3 key={`h3-${i}`} className="md-h3">{inline}</h3>);
        else if (level === 4) blocks.push(<h4 key={`h4-${i}`} className="md-h4">{inline}</h4>);
        else if (level === 5) blocks.push(<h5 key={`h5-${i}`} className="md-h5">{inline}</h5>);
        else blocks.push(<h6 key={`h6-${i}`} className="md-h6">{inline}</h6>);
        i++;
        continue;
      }

      // Horizontal rule: --- or *** or ___
      if (/^(\-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        blocks.push(<hr key={`hr-${i}`} className="md-hr" />);
        i++;
        continue;
      }

      // Blockquote: > text
      if (trimmed.startsWith(">")) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        blocks.push(
          <blockquote key={`quote-${i}`} className="md-blockquote">
            {quoteLines.map((q, qIdx) => (
              <p key={qIdx}>{renderInline(q)}</p>
            ))}
          </blockquote>
        );
        continue;
      }

      // Table: lines starting and ending with |
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        const tableLines: string[] = [];
        while (i < lines.length && lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|")) {
          tableLines.push(lines[i].trim());
          i++;
        }
        if (tableLines.length >= 2) {
          const parseRow = (row: string) =>
            row
              .slice(1, -1)
              .split("|")
              .map(c => c.trim());
          const headerRow = parseRow(tableLines[0]);
          const isSeparator = /^\|?(\s*:?-+:?\s*\|?)+$/.test(tableLines[1]);
          const dataRows = (isSeparator ? tableLines.slice(2) : tableLines.slice(1)).map(parseRow);

          blocks.push(
            <div key={`table-${i}`} className="md-table-wrap">
              <table className="md-table tbl">
                <thead>
                  <tr>
                    {headerRow.map((col, cIdx) => (
                      <th key={cIdx}>{renderInline(col)}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dataRows.map((row, rIdx) => (
                    <tr key={rIdx}>
                      {row.map((cell, cIdx) => (
                        <td key={cIdx}>{renderInline(cell)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
          continue;
        }
      }

      // Unordered list: - item or * item
      if (/^[-*+]\s+/.test(trimmed)) {
        const listItems: string[] = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i].trim())) {
          listItems.push(lines[i].trim().replace(/^[-*+]\s+/, ""));
          i++;
        }
        blocks.push(
          <ul key={`ul-${i}`} className="md-ul">
            {listItems.map((item, idx) => (
              <li key={idx}>{renderInline(item)}</li>
            ))}
          </ul>
        );
        continue;
      }

      // Ordered list: 1. item
      if (/^\d+\.\s+/.test(trimmed)) {
        const listItems: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          listItems.push(lines[i].trim().replace(/^\d+\.\s+/, ""));
          i++;
        }
        blocks.push(
          <ol key={`ol-${i}`} className="md-ol">
            {listItems.map((item, idx) => (
              <li key={idx}>{renderInline(item)}</li>
            ))}
          </ol>
        );
        continue;
      }

      // Standard paragraph: gather consecutive non-empty lines
      const paragraphLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].trim().startsWith("```") &&
        !lines[i].trim().startsWith("#") &&
        !lines[i].trim().startsWith(">") &&
        !/^[-*+]\s+/.test(lines[i].trim()) &&
        !/^\d+\.\s+/.test(lines[i].trim()) &&
        !/^(\-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
        !(lines[i].trim().startsWith("|") && lines[i].trim().endsWith("|"))
      ) {
        paragraphLines.push(lines[i]);
        i++;
      }
      blocks.push(
        <p key={`p-${i}`} className="md-p">
          {paragraphLines.map((l, pIdx) => (
            <span key={pIdx}>
              {pIdx > 0 && <br />}
              {renderInline(l)}
            </span>
          ))}
        </p>
      );
    }

    return blocks;
  }, [content]);

  return <div className={`markdown-preview ${className}`}>{renderedNodes}</div>;
}
