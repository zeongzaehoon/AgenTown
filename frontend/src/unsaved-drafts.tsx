import { useEffect } from 'react';

// Independent contributors compose through the browser event: clearing one
// draft cannot remove another feature's protection.
export function useUnsavedDrafts(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    function confirmLeave(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', confirmLeave);
    return () => window.removeEventListener('beforeunload', confirmLeave);
  }, [dirty]);
}

export function DraftStatus({labels}: {labels: string[]}) {
  useUnsavedDrafts(labels.length > 0);
  return labels.length ? <p role="status">Unsaved drafts: {labels.join('; ')}. Leaving or reloading may discard these changes.</p> : null;
}
