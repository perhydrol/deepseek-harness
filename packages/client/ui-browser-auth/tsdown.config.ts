import { clientBundle } from '../tsdown.client.ts'

export default clientBundle('@hydrogen/dsh-client-ui-browser-auth', ['lib/types/index.js'], {
  companions: [{
    name: '@hydrogen/dsh-client-ui-browser-auth/login',
    entry: { login: 'lib/types/public/index.js' }, outDir: 'lib', format: 'esm', platform: 'browser',
    target: 'es2024', dts: false, clean: false, sourcemap: false,
    deps: { alwaysBundle: () => true },
    copy: [
      { from: '../ui-theme/src/styles/{base,design-platform}.css', to: 'lib/styles' },
      { from: 'src/public/page.css', to: 'lib/styles' },
    ],
  }],
})
