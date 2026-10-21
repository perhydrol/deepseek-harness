/** iOS input font floor and keyboard-aware app sizing, owned by one shell slot. */
import { viewportFrame, watchViewport } from './viewport.js';

window.__ModuleLoader__.load({
  id: '@local/dsh-ios-input-fix',
  factory(require) {
    const React = require('react');
    return {
      inject: ['slots'],
      apply(ctx) {
        function InputViewportStyles() {
          const [frame, setFrame] = React.useState(null);
          React.useLayoutEffect(() => {
            if (!CSS.supports('-webkit-touch-callout', 'none') || !window.matchMedia('(any-pointer: coarse)').matches) return;
            const viewport = window.visualViewport;
            if (viewport === null || viewport === undefined) return;
            return watchViewport({
              viewport, page: window,
              requestFrame: callback => window.requestAnimationFrame(callback),
              cancelFrame: id => window.cancelAnimationFrame(id),
              read: () => viewportFrame(viewport),
            }, next => {
              if (next === null) return;
              setFrame(previous => previous !== null && previous.width === next.width && previous.height === next.height
                && previous.top === next.top && previous.left === next.left ? previous : next);
            });
          }, []);
          const root = frame === null ? '' : `
            #root {
              position: fixed;
              top: ${frame.top}px;
              left: ${frame.left}px;
              width: ${frame.width}px;
              height: ${frame.height}px;
              min-height: 0;
              box-sizing: border-box;
              padding: env(safe-area-inset-top, 0px) env(safe-area-inset-right, 0px)
                env(safe-area-inset-bottom, 0px) env(safe-area-inset-left, 0px);
            }`;
          return React.createElement('style', { 'data-ios-input-fix': '' }, `
            @supports (-webkit-touch-callout: none) {
              @media (any-pointer: coarse) {
                [data-composer-card] :is([data-composer-input], [data-composer-placeholder]) {
                  font-size: max(16px, var(--dsh-content-font-size, 14px));
                }
                ${root}
              }
            }`);
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'ios-input-fix', order: 0,
        }, InputViewportStyles));
      },
    };
  },
});
