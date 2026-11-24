const MONACO_VS = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs';
const MONACO_LOADER_URL = `${MONACO_VS}/loader.js`;

let cachedSortable = null;
let sortableLoadPromise = null;
let monacoLoadPromise = null;
let monacoWorkerUrl = null;

/**
 * Lazy-load Monaco Editor AMD loader and editor.main bundle once on demand.
 */
export function ensureMonacoLoaded() {
  if (typeof window !== 'undefined' && typeof window.monaco !== 'undefined' && window.monaco?.editor) {
    return Promise.resolve(window.monaco);
  }
  if (monacoLoadPromise) {
    return monacoLoadPromise;
  }

  monacoLoadPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      reject(new Error('Browser environment is unavailable'));
      return;
    }

    const loadEditorMain = () => {
      if (typeof window.monaco !== 'undefined' && window.monaco?.editor) {
        resolve(window.monaco);
        return;
      }
      if (typeof window.require !== 'function' || !window.require.config) {
        reject(new Error('Monaco AMD loader is unavailable'));
        return;
      }

      window.MonacoEnvironment = {
        getWorkerUrl() {
          if (!monacoWorkerUrl) {
            const code = `self.MonacoEnvironment={baseUrl:'${MONACO_VS}/'};importScripts('${MONACO_VS}/base/worker/workerMain.js');`;
            monacoWorkerUrl = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
          }
          return monacoWorkerUrl;
        }
      };

      window.require.config({ paths: { vs: MONACO_VS } });
      window.require(
        ['vs/editor/editor.main'],
        () => {
          if (typeof window.monaco !== 'undefined' && window.monaco?.editor) {
            resolve(window.monaco);
          } else {
            reject(new Error('Monaco editor failed to initialize'));
          }
        },
        (err) => reject(err || new Error('Failed to load vs/editor/editor.main'))
      );
    };

    if (typeof window.require === 'function' && window.require.config) {
      loadEditorMain();
      return;
    }

    const existingScript = document.querySelector(`script[src="${MONACO_LOADER_URL}"]`);
    if (existingScript) {
      existingScript.addEventListener('load', loadEditorMain, { once: true });
      existingScript.addEventListener('error', () => {
        existingScript.remove();
        reject(new Error('Failed to load Monaco loader.js'));
      }, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = MONACO_LOADER_URL;
    script.async = true;
    script.addEventListener('load', loadEditorMain, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error('Failed to load Monaco loader.js'));
    }, { once: true });
    document.head.appendChild(script);
  }).catch((err) => {
    monacoLoadPromise = null;
    throw err;
  });

  return monacoLoadPromise;
}

/**
 * Load Monaco on demand and mount a YAML editor instance into container.
 */
export async function createMonacoYamlEditor(container, { value = '', onChange } = {}) {
  const monaco = await ensureMonacoLoaded();
  if (!container || !monaco?.editor) return null;

  const editor = monaco.editor.create(container, {
    value: String(value ?? ''),
    language: 'yaml',
    tabSize: 2,
    insertSpaces: true,
    minimap: { enabled: false },
    automaticLayout: true,
    fontSize: 14,
    lineNumbersMinChars: 3,
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    ariaLabel: 'Nội dung đề YAML'
  });

  if (typeof onChange === 'function') {
    editor.onDidChangeModelContent((e) => {
      onChange(editor.getValue(), e);
    });
  }

  editor.layout();
  return editor;
}

/**
 * Sync parser line errors ("Dòng N: ...") onto a Monaco editor model.
 */
export function syncMonacoMarkers(monacoEditor, errors) {
  if (!monacoEditor || typeof window === 'undefined' || !window.monaco?.editor) return;
  const model = monacoEditor.getModel();
  if (!model) return;

  const markers = [];
  (errors || []).forEach((msg) => {
    const match = /^Dòng (\d+):/.exec(msg);
    if (match) {
      const line = Math.min(Math.max(1, Number(match[1])), model.getLineCount());
      markers.push({
        severity: window.monaco.MarkerSeverity.Error,
        message: msg,
        startLineNumber: line,
        startColumn: 1,
        endLineNumber: line,
        endColumn: model.getLineMaxColumn(line)
      });
    }
  });
  window.monaco.editor.setModelMarkers(model, 'ontap-yaml', markers);
}

/**
 * Lazy-load SortableJS once on demand with retry-safe failure handling.
 */
export async function loadSortable() {
  if (cachedSortable) return cachedSortable;
  if (!sortableLoadPromise) {
    sortableLoadPromise = import('sortablejs')
      .then((mod) => {
        const Sortable = mod?.default || mod;
        if (!Sortable) throw new Error('SortableJS export missing');
        cachedSortable = Sortable;
        return Sortable;
      })
      .catch((err) => {
        sortableLoadPromise = null;
        console.warn('Không thể tải SortableJS:', err);
        return null;
      });
  }
  return sortableLoadPromise;
}
