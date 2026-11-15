import { useLayoutEffect, useRef } from 'react';
import { newId } from '@zichan/core';
import { useCompactView } from './useCompactView.js';

interface BackOwner { id: string; dismiss: () => void; disabled: () => boolean; state: Record<string, unknown>; }
const owners: BackOwner[] = [];
let installed = false;
let expectedPops = 0;

// Page listeners can predate this coordinator. They must also defer while a
// sheet owns Back, including the traversal caused by programmatic cleanup.
export function hasMobileDialog() { return owners.length > 0 || expectedPops > 0; }

function settle() {
  const top = owners.at(-1);
  if (top && history.state?.zcDialog !== top.id) history.pushState(top.state, '');
  else if (!top && history.state?.zcDialog) { expectedPops += 1; history.back(); }
  else if (!top && expectedPops === 0) window.dispatchEvent(new Event('zichan:dialog-history-settled'));
}

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('popstate', (event) => {
    const top = owners.at(-1);
    if (expectedPops > 0) {
      expectedPops -= 1;
      event.stopImmediatePropagation();
      requestAnimationFrame(settle);
      return;
    }
    if (!top) {
      if (history.state?.zcDialog) { event.stopImmediatePropagation(); expectedPops += 1; history.back(); }
      return;
    }
    if (history.state?.zcDialog === top.id) return;
    event.stopImmediatePropagation();
    if (top.disabled()) history.pushState(top.state, '');
    else {
      top.dismiss();
      // A dirty form may open a confirmation instead of closing. After React's
      // commit, keep the surviving top dialog in the back stack.
      requestAnimationFrame(settle);
    }
  }, true);
}

/** Browser / webview Back closes the top sheet before changing the underlying page. */
export function useMobileDialogHistory(onDismiss: (() => void) | undefined, disabled: boolean, active: boolean) {
  const compact = useCompactView();
  const canDismiss = !!onDismiss;
  const callback = useRef(onDismiss);
  const blocked = useRef(disabled);
  callback.current = onDismiss; blocked.current = disabled;
  useLayoutEffect(() => {
    if (!compact || !active || !canDismiss) return;
    let alive = true;
    let owner: BackOwner | undefined;
    // Strict Mode's first setup/cleanup pair must not leave a phantom entry.
    queueMicrotask(() => {
      if (!alive) return;
      install();
      const id = newId();
      owner = { id, dismiss: () => callback.current?.(), disabled: () => blocked.current, state: { ...history.state, zcDialog: id } };
      owners.push(owner);
      history.pushState(owner.state, '');
    });
    return () => {
      alive = false;
      if (!owner) return;
      const index = owners.indexOf(owner);
      if (index >= 0) owners.splice(index, 1);
      const closedId = owner.id;
      // Replacing a loading sheet or an editor can mount its successor in this
      // same commit. Do not start an asynchronous traversal before that owner
      // has had a chance to register its own entry.
      requestAnimationFrame(() => {
        if (history.state?.zcDialog === closedId) { expectedPops += 1; history.back(); }
      });
    };
  }, [compact, active, canDismiss]);
}
