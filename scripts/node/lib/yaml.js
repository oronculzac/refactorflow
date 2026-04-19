'use strict';

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function countIndent(line) {
  let count = 0;
  while (count < line.length && line[count] === ' ') {
    count += 1;
  }
  return count;
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      let escaped = false;
      let back = i - 1;
      while (back >= 0 && line[back] === '\\') {
        escaped = !escaped;
        back -= 1;
      }
      if (!escaped) {
        inDouble = !inDouble;
      }
    } else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) {
        return line.slice(0, i).trimEnd();
      }
    }
  }
  return line.trimEnd();
}

function parseScalar(raw) {
  const text = String(raw).trim();
  if (text === '' || text === '~' || text === 'null') {
    return null;
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (/^-?\d+$/.test(text)) {
    return Number(text);
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    return Number(text);
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    return JSON.parse(text);
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    if (inner === '') {
      return [];
    }
    return splitComma(inner).map((part) => parseScalar(part));
  }
  return text;
}

function splitComma(text) {
  const parts = [];
  let current = '';
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      let escaped = false;
      let back = i - 1;
      while (back >= 0 && text[back] === '\\') {
        escaped = !escaped;
        back -= 1;
      }
      if (!escaped) {
        inDouble = !inDouble;
      }
      current += ch;
      continue;
    }
    if (!inSingle && !inDouble) {
      if (ch === '[' || ch === '{') {
        depth += 1;
      } else if (ch === ']' || ch === '}') {
        depth -= 1;
      } else if (ch === ',' && depth === 0) {
        parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += ch;
  }
  if (current.trim() !== '') {
    parts.push(current.trim());
  }
  return parts;
}

function parseYaml(text) {
  const lines = stripBom(String(text)).replace(/\r\n/g, '\n').split('\n');

  function parseBlock(startIndex, indent) {
    let container = null;
    let i = startIndex;

    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '' || raw.trim().startsWith('#')) {
        i += 1;
        continue;
      }

      const currentIndent = countIndent(raw);
      if (currentIndent < indent) {
        break;
      }
      if (currentIndent > indent) {
        break;
      }

      const line = stripComment(raw.slice(indent));
      if (!line) {
        i += 1;
        continue;
      }

      if (line.startsWith('- ')) {
        if (container === null) {
          container = [];
        } else if (!Array.isArray(container)) {
          throw new Error('Mixed YAML container types are not supported');
        }
        const itemText = line.slice(2).trim();
        if (itemText === '') {
          const child = parseBlock(i + 1, indent + 2);
          container.push(child.value);
          i = child.index;
          continue;
        }
        if (/^[^:]+:\s*/.test(itemText)) {
          const fragment = parseInlineMapItem(itemText, i + 1, indent + 2, parseBlock, parseBlockScalar);
          container.push(fragment.value);
          i = fragment.index;
          continue;
        }
        container.push(parseScalar(itemText));
        i += 1;
        continue;
      }

      if (container === null) {
        container = {};
      } else if (Array.isArray(container)) {
        throw new Error('Mixed YAML container types are not supported');
      }

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) {
        throw new Error(`Invalid YAML line: ${line}`);
      }

      const key = line.slice(0, colonIndex).trim();
      const rest = line.slice(colonIndex + 1).trim();

      if (rest === '') {
        const child = parseBlock(i + 1, indent + 2);
        container[key] = child.value;
        i = child.index;
        continue;
      }

      if (rest === '|' || rest === '>') {
        const child = parseBlockScalar(i + 1, indent + 2);
        container[key] = rest === '|' ? child.value : foldBlock(child.value);
        i = child.index;
        continue;
      }

      container[key] = parseScalar(rest);
      i += 1;
    }

    return { value: container, index: i };
  }

  function parseBlockScalar(startIndex, indent) {
    const out = [];
    let i = startIndex;
    while (i < lines.length) {
      const raw = lines[i];
      if (raw.trim() === '') {
        out.push('');
        i += 1;
        continue;
      }
      const currentIndent = countIndent(raw);
      if (currentIndent < indent) {
        break;
      }
      out.push(raw.slice(indent));
      i += 1;
    }
    return { value: out.join('\n'), index: i };
  }

  function parseInlineMapItem(itemText, nextIndex, nextIndent) {
    const fragment = {};
    const colonIndex = itemText.indexOf(':');
    const key = itemText.slice(0, colonIndex).trim();
    const rest = itemText.slice(colonIndex + 1).trim();
    if (rest === '' || rest === '|' || rest === '>') {
      const child = rest === '|' || rest === '>' ? parseBlockScalar(nextIndex, nextIndent) : parseBlock(nextIndex, nextIndent);
      fragment[key] = rest === '>' ? foldBlock(child.value) : child.value;
      return { value: fragment, index: child.index };
    }
    fragment[key] = parseScalar(rest);
    const child = parseBlock(nextIndex, nextIndent);
    if (child.value && typeof child.value === 'object' && !Array.isArray(child.value)) {
      Object.assign(fragment, child.value);
    }
    return { value: fragment, index: child.index };
  }

  function foldBlock(blockValue) {
    if (typeof blockValue !== 'string') {
      return blockValue;
    }
    return blockValue
      .split('\n')
      .map((line) => line.trimEnd())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const parsed = parseBlock(0, 0).value;
  return parsed == null ? {} : parsed;
}

function needsQuoting(text) {
  return (
    text === '' ||
    /^[\s]|[\s]$/.test(text) ||
    /[:#\[\]\{\},&*?|\-<>=!%@\\]/.test(text) ||
    text.includes('\n') ||
    text === 'null' ||
    text === 'true' ||
    text === 'false' ||
    /^[-+]?\d+(\.\d+)?$/.test(text)
  );
}

function quoteString(text) {
  return JSON.stringify(text);
}

function stringifyScalar(value) {
  if (value === null || typeof value === 'undefined') {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'null';
  }
  const text = String(value);
  if (text.includes('\n')) {
    return `|\n${text.split('\n').map((line) => `  ${line}`).join('\n')}`;
  }
  return needsQuoting(text) ? quoteString(text) : text;
}

function indentLines(text, indent) {
  const pad = ' '.repeat(indent);
  return String(text)
    .split('\n')
    .map((line) => `${pad}${line}`)
    .join('\n');
}

function stringifyYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return `${pad}[]`;
    }
    return value
      .map((item) => {
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const rendered = stringifyYaml(item, indent + 2);
          const lines = rendered.split('\n');
          const first = lines.shift();
          return `${pad}- ${first.trimStart()}\n${lines.map((line) => line).join('\n')}`.trimEnd();
        }
        const rendered = stringifyScalar(item);
        if (rendered.includes('\n')) {
          return `${pad}- ${rendered.split('\n').join(`\n${' '.repeat(indent + 2)}`)}`;
        }
        return `${pad}- ${rendered}`;
      })
      .join('\n');
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return `${pad}{}`;
    }
    return entries
      .map(([key, entryValue]) => {
        if (entryValue && typeof entryValue === 'object') {
          if (Array.isArray(entryValue)) {
            if (entryValue.length === 0) {
              return `${pad}${key}: []`;
            }
            return `${pad}${key}:\n${stringifyYaml(entryValue, indent + 2)}`;
          }
          if (Object.keys(entryValue).length === 0) {
            return `${pad}${key}: {}`;
          }
          return `${pad}${key}:\n${stringifyYaml(entryValue, indent + 2)}`;
        }
        const rendered = stringifyScalar(entryValue);
        if (rendered.includes('\n')) {
          return `${pad}${key}: ${rendered}`;
        }
        return `${pad}${key}: ${rendered}`;
      })
      .join('\n');
  }

  return `${pad}${stringifyScalar(value)}`;
}

module.exports = {
  parseYaml,
  stringifyYaml,
};
