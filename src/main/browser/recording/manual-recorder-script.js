export const MANUAL_RECORDER_EVENT_PREFIX = "[ManualRecorder]"
export const MANUAL_RECORDER_INJECTION_FLAG = "__cmbManualRecorderInstalled"
export const SUPPORTED_PRESS_KEYS = new Set([
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight"
])

export function buildManualRecorderInjectionScript() {
  return String.raw`(() => {
    if (window.${MANUAL_RECORDER_INJECTION_FLAG}) return;
    window.${MANUAL_RECORDER_INJECTION_FLAG} = true;

    const PREFIX = ${JSON.stringify(MANUAL_RECORDER_EVENT_PREFIX)};
    const SUPPORTED_KEYS = new Set(${JSON.stringify(Array.from(SUPPORTED_PRESS_KEYS))});

    function text(value) {
      return typeof value === "string" ? value.trim() : "";
    }

    function safeText(value, limit = 120) {
      const next = text(value).replace(/\s+/g, " ");
      return next ? next.slice(0, limit) : "";
    }

    function cssEscape(value) {
      if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
      return String(value).replace(/([#.;?+*~':"!^$[\]()=>|/@])/g, "\\$1");
    }

    function emit(payload) {
      try {
        console.log(PREFIX + JSON.stringify({
          ...payload,
          timestamp: new Date().toISOString(),
          frameUrl: location.href
        }));
      } catch {}
    }

    function roleForElement(element) {
      const explicitRole = text(element.getAttribute("role")).toLowerCase();
      if (explicitRole) return explicitRole;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "option") return "option";
      if (tag === "input") {
        const type = text(element.getAttribute("type")).toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "button" || type === "submit" || type === "reset") return "button";
        return "textbox";
      }
      return "";
    }

    function labelForElement(element) {
      const ariaLabel = text(element.getAttribute("aria-label"));
      if (ariaLabel) return ariaLabel;

      const labelledBy = text(element.getAttribute("aria-labelledby"));
      if (labelledBy) {
        const label = labelledBy
          .split(/\s+/)
          .map((id) => document.getElementById(id))
          .filter(Boolean)
          .map((node) => safeText(node.textContent, 80))
          .filter(Boolean)
          .join(" ");
        if (label) return label;
      }

      const id = text(element.id);
      if (id) {
        const labelNode = document.querySelector('label[for="' + cssEscape(id) + '"]');
        const labelText = safeText(labelNode?.textContent, 80);
        if (labelText) return labelText;
      }

      const wrappedLabel = element.closest("label");
      const wrappedLabelText = safeText(wrappedLabel?.textContent, 80);
      if (wrappedLabelText) return wrappedLabelText;

      return "";
    }

    function targetForElement(element) {
      return (
        text(element.getAttribute("data-testid")) ||
        labelForElement(element) ||
        text(element.getAttribute("placeholder")) ||
        safeText(element.innerText || element.textContent, 80) ||
        text(element.getAttribute("title")) ||
        text(element.getAttribute("name"))
      );
    }

    function selectorForElement(element) {
      if (element.id) return '#' + cssEscape(element.id);
      const testId = text(element.getAttribute("data-testid"));
      if (testId) return '[data-testid="' + testId.replace(/"/g, '\\"') + '"]';
      const name = text(element.getAttribute("name"));
      if (name) return element.tagName.toLowerCase() + '[name="' + name.replace(/"/g, '\\"') + '"]';
      return element.tagName.toLowerCase();
    }

    function locatorForElement(element) {
      if (!(element instanceof Element)) return undefined;
      const tagName = element.tagName.toLowerCase();
      const role = roleForElement(element);
      const label = labelForElement(element);
      const placeholder = text(element.getAttribute("placeholder"));
      const accessibleName = label || text(element.getAttribute("aria-label")) || safeText(element.innerText || element.textContent, 80);
      const inputType = tagName === "input" ? text(element.getAttribute("type")).toLowerCase() || "text" : undefined;
      return {
        target: targetForElement(element),
        role,
        label,
        placeholder,
        testId: text(element.getAttribute("data-testid")),
        accessibleName,
        textContent: safeText(element.innerText || element.textContent, 80),
        selector: selectorForElement(element),
        tagName,
        inputType
      };
    }

    function isDecorativeRole(role) {
      return role === 'img' || role === 'presentation' || role === 'none';
    }

    function hasMeaningfulLocator(locator) {
      if (!locator) return false;
      const tagName = text(locator.tagName).toLowerCase();
      const role = text(locator.role).toLowerCase();
      if (tagName && /^(svg|path|g|use|defs|symbol|rect|circle|ellipse|line|polyline|polygon)$/i.test(tagName)) {
        return false;
      }
      if (role && isDecorativeRole(role)) return false;
      return Boolean(
        locator.testId ||
        locator.label ||
        locator.placeholder ||
        locator.accessibleName ||
        locator.textContent ||
        locator.target ||
        (tagName && ['button', 'a', 'input', 'textarea', 'select', 'option'].includes(tagName)) ||
        (role && !isDecorativeRole(role))
      );
    }

    function locatorCandidatesForTarget(target) {
      if (!(target instanceof Element)) return [];

      const candidates = [];
      const seen = new Set();
      let current = target;
      while (current && current !== document.body && current !== document.documentElement) {
        const locator = locatorForElement(current);
        if (hasMeaningfulLocator(locator)) {
          const key = JSON.stringify(locator);
          if (!seen.has(key)) {
            candidates.push(locator);
            seen.add(key);
          }
        }

        const role = text(current.getAttribute('role')).toLowerCase();
        const tagName = current.tagName.toLowerCase();
        if (
          (['button', 'a', 'input', 'textarea', 'select', 'option'].includes(tagName) ||
            (!!role && !isDecorativeRole(role)) ||
            current.hasAttribute('tabindex')) &&
          !isDecorativeRole(role)
        ) {
          break;
        }

        current = current.parentElement;
      }

      return candidates.slice(0, 6);
    }

    function actionableTarget(target) {
      if (!(target instanceof Element)) return null;
      const candidates = locatorCandidatesForTarget(target);
      return candidates.length > 0 ? candidates[0] : null;
    }

    document.addEventListener('click', (event) => {
      const locatorCandidates = locatorCandidatesForTarget(event.target);
      const locator = locatorCandidates[0];
      if (!locator) return;
      emit({
        type: 'click',
        locator,
        locatorCandidates,
        doubleClick: event.detail === 2
      });
    }, true);

    function emitTextFill(target) {
      emit({ type: 'fill', locator: locatorForElement(target), value: target.value });
    }

    document.addEventListener('input', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
      if (target instanceof HTMLInputElement) {
        if (target.type === 'file' || target.type === 'checkbox' || target.type === 'radio') {
          return;
        }
      }

      emitTextFill(target);
    }, true);

    document.addEventListener('change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
      if (target instanceof HTMLSelectElement) {
        emit({
          type: 'select',
          locator: locatorForElement(target),
          values: Array.from(target.selectedOptions).map((option) => text(option.value) || safeText(option.textContent, 80)).filter(Boolean)
        });
        return;
      }

      if (target instanceof HTMLInputElement && target.type === 'file') {
        const paths = Array.from(target.files ?? [])
          .map((file) => {
            const path = text(file?.path);
            return path || text(file?.webkitRelativePath) || text(file?.name);
          })
          .filter(Boolean);
        if (paths.length === 0) {
          const inputValue = text(target.value);
          if (inputValue) paths.push(inputValue);
        }
        if (paths.length > 0) {
          emit({ type: 'fileUpload', locator: locatorForElement(target), paths });
        }
        return;
      }

      if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) {
        return;
      }
    }, true);

    document.addEventListener('keydown', (event) => {
      if (!SUPPORTED_KEYS.has(event.key)) return;
      const target = actionableTarget(event.target);
      emit({ type: 'press', key: event.key, locator: target ?? undefined });
    }, true);

    window.addEventListener('hashchange', () => {
      emit({ type: 'navigate', url: location.href });
    });
  })();`
}
