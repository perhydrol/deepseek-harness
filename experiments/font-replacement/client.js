/** Load the bundled faces through a shell slot, then select the three font roles. */
window.__ModuleLoader__.load({
  id: '@local/dsh-font-replacement',
  factory(require) {
    const React = require('react');
    const { flushSync } = require('react-dom');

    return {
      inject: ['slots', 'theme'],
      apply(ctx) {
        function FontStylesheet() {
          const alive = React.useRef(false);
          React.useLayoutEffect(() => {
            alive.current = true;
            return () => { alive.current = false; };
          }, []);
          async function selectFonts() {
            try {
              // Xterm measures cells when its font changes; load representative glyphs first.
              const loaded = await Promise.all([
                document.fonts.load('14px "HarmonyOS Sans SC"', 'Hello 你好'),
                document.fonts.load('13px "Maple Mono NL NF CN"', 'MWil01 你好'),
              ]);
              if (loaded.some(faces => faces.length === 0)) throw new Error('Bundled font faces were not registered');
              if (!alive.current) return;
              ctx.theme.setFontFamily('text', 'HarmonyOS Sans SC');
              ctx.theme.setFontFamily('code', 'Maple Mono NL NF CN');
              // A saved identical name otherwise leaves an already-mounted Xterm using fallback metrics.
              if (ctx.theme.getTheme().fontFamilies.terminal === '"Maple Mono NL NF CN"') {
                flushSync(() => { ctx.theme.setFontFamily('terminal', ''); });
              }
              ctx.theme.setFontFamily('terminal', 'Maple Mono NL NF CN');
            } catch (error) {
              console.error('Font replacement could not load fonts; check the bundle asset requests and reload.', error);
            }
          }
          return React.createElement('link', {
            rel: 'stylesheet', href: '/font-replacement/fonts.css',
            onLoad: selectFonts,
            onError: () => { console.error('Font replacement stylesheet failed to load; enable the Host plugin and reload.'); },
          });
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'font-replacement', order: 0,
        }, FontStylesheet));
      },
    };
  },
});
