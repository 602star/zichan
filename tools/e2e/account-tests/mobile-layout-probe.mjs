// Shared layout probe for the phone/tablet web contract.
//
// Runs in the page against a real, data-populated ledger and returns raw
// measurements. Keeping it dependency-free means the same probe can be used
// from a focused debugging script and from the committed Playwright spec.

/**
 * Measure the current screen.
 * @param {{ maxScroll?: boolean }} options
 */
export function mobileLayoutProbe(options) {
  const { maxScroll } = options;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // A closed <details> can still return geometry for unpainted descendants.
  // Check every ancestor: an inner summary is hidden when its outer details is closed.
  const hiddenByClosedDetails = (el) => {
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (!(ancestor instanceof HTMLDetailsElement) || ancestor.open) continue;
      const summary = [...ancestor.children].find((child) => child.tagName === 'SUMMARY');
      if (!summary?.contains(el)) return true;
    }
    return false;
  };

  const visible = (el) => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (hiddenByClosedDetails(el)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const describe = (el) => {
    const id = el.id ? `#${el.id}` : '';
    const cls = typeof el.className === 'string' && el.className
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : '';
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26);
    return `${el.tagName.toLowerCase()}${id}${cls} "${text}"`;
  };

  // A checkbox is tappable through its wrapper or its label, so the effective
  // hit area is the ancestor box, not the 18px control itself.
  const hitTarget = (el) => {
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      const wrapper = el.closest('.zc-check-target') || el.closest('label');
      if (wrapper) return wrapper;
    }
    return el;
  };

  const scroller = document.scrollingElement;

  const docOverflow = document.documentElement.scrollWidth - vw;
  const overflowing = [];
  for (const el of document.querySelectorAll('body *')) {
    if (!visible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.right > vw + 1 || rect.left < -1) {
      let ancestor = el.parentElement;
      let insideScroller = false;
      while (ancestor && ancestor !== document.body) {
        const ox = getComputedStyle(ancestor).overflowX;
        if (ox === 'auto' || ox === 'scroll') { insideScroller = true; break; }
        ancestor = ancestor.parentElement;
      }
      if (insideScroller) continue;
      overflowing.push({ el: describe(el), right: Math.round(rect.right), left: Math.round(rect.left) });
    }
  }

  const smallTargets = [];
  for (const el of document.querySelectorAll('button, a[href], select, summary, [role="button"], input[type="checkbox"], input[type="radio"]')) {
    if (!visible(el)) continue;
    if (el.closest('[aria-hidden="true"]')) continue;
    if (el.hasAttribute('disabled')) continue;
    const target = hitTarget(el);
    const rect = target.getBoundingClientRect();
    if (rect.height < 44 || rect.width < 44) {
      smallTargets.push({
        el: describe(el),
        via: target === el ? 'self' : target.className,
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      });
    }
  }

  const smallInputs = [];
  for (const el of document.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="range"]), select, textarea')) {
    if (!visible(el)) continue;
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 16) smallInputs.push({ el: describe(el), fontSize: size });
  }

  let occlusion = null;
  const nav = document.querySelector('.zc-mobile-bottom-nav');
  if (nav && visible(nav)) {
    const navRect = nav.getBoundingClientRect();
    const content = document.querySelector('.zc-page-content');
    const covered = [];
    if (content) {
      for (const el of content.querySelectorAll('*')) {
        if (!visible(el)) continue;
        if (el.children.length > 0 && (el.textContent || '').length > 80) continue;
        const rect = el.getBoundingClientRect();
        if (rect.bottom > navRect.top + 1 && rect.top < navRect.bottom && rect.height <= navRect.height) {
          covered.push({ el: describe(el), overlap: Math.round(Math.min(rect.bottom, navRect.bottom) - Math.max(rect.top, navRect.top)) });
        }
      }
    }
    occlusion = {
      atMaxScroll: maxScroll,
      reachable: Math.abs((scroller ? scroller.scrollTop : 0) + vh - (scroller ? scroller.scrollHeight : 0)) < 4,
      contentPaddingBottom: content ? Math.round(parseFloat(getComputedStyle(content).paddingBottom)) : null,
      covered: covered.slice(0, 8),
    };
  }

  const clipped = [];
  for (const el of document.querySelectorAll('span, div, b, small, td, th, label, p, pre')) {
    if (!visible(el) || el.children.length > 0) continue;
    const style = getComputedStyle(el);
    if (style.overflow !== 'hidden' && style.overflowX !== 'hidden') continue;
    if (style.textOverflow === 'ellipsis') continue;
    if (el.scrollWidth > el.clientWidth + 2) clipped.push({ el: describe(el), client: el.clientWidth, scroll: el.scrollWidth });
  }

  // Dashboard headline: a wide net-worth figure used to push the as-of date off
  // screen with no visible error.
  let hero = null;
  const amount = document.querySelector('.zc-hero-amount');
  const asOf = document.querySelector('.zc-hero-asof');
  if (amount && asOf) {
    const a = amount.getBoundingClientRect();
    const b = asOf.getBoundingClientRect();
    hero = {
      amountRight: Math.round(a.right),
      asOfRight: Math.round(b.right),
      viewportWidth: vw,
      asOfVisible: b.right <= vw + 1 && b.left >= -1 && b.width > 0,
      amountOverflows: a.right > vw + 1,
    };
  }

  return {
    vw,
    docOverflow,
    overflowing: overflowing.slice(0, 20),
    smallTargets: smallTargets.slice(0, 25),
    smallInputCount: smallInputs.length,
    smallInputs: smallInputs.slice(0, 10),
    occlusion,
    clipped: clipped.slice(0, 12),
    hero,
  };
}

/**
 * Scroll the viewport to the bottom so occlusion is measured at the worst case.
 */
export function scrollToPageBottom() {
  return new Promise((resolve) => {
    const scroller = document.scrollingElement;
    scroller.scrollTop = scroller.scrollHeight;
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}
