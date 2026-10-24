(function () {
  function viewportHeight() {
    const visual = window.visualViewport && typeof window.visualViewport.height === 'number' ? window.visualViewport.height : 0;
    return Math.min(window.innerHeight || 0, visual || window.innerHeight || 0) || document.documentElement.clientHeight || 0;
  }

  function applyViewportFix(modal) {
    const sheet = modal && modal.querySelector ? modal.querySelector('.sheet') : null;
    if (!sheet) return;

    const height = viewportHeight();
    if (!height) return;

    const limit = Math.max(220, height - 20);
    sheet.style.maxHeight = `${limit}px`;
    sheet.style.height = 'auto';

    if (window.matchMedia('(orientation: landscape)').matches && window.innerWidth > 1200 && height < 800) {
      sheet.style.maxHeight = `${Math.max(220, height - 12)}px`;
    }

    modal.style.alignItems = height < 560 ? 'center' : '';
    modal.style.padding = height < 560 ? '12px' : '';
  }

  const previous = typeof window.applySheetViewportHeight === 'function' ? window.applySheetViewportHeight : null;
  window.applySheetViewportHeight = function (modal) {
    if (previous) {
      try {
        previous.call(this, modal);
      } catch (error) {
        console.warn('Previous applySheetViewportHeight failed:', error);
      }
    }
    if (modal) {
      applyViewportFix(modal);
    }
  };

  function refreshOpenModal() {
    const modal = document.getElementById('modal');
    if (modal && !modal.classList.contains('hidden')) {
      applyViewportFix(modal);
    }
  }

  window.addEventListener('resize', refreshOpenModal, { passive: true });
  window.addEventListener('orientationchange', refreshOpenModal, { passive: true });

  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', refreshOpenModal, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', refreshOpenModal);
})();
