module.exports = {
  appId: 'dev.rivet.desktop',
  productName: 'Rivet',
  directories: { output: 'release' },
  files: ['main.cjs', 'package.json'],
  afterPack: async context => {
    const { cp } = require('node:fs/promises');
    const { join } = require('node:path');
    const resources = context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
      : join(context.appOutDir, 'resources');
    await cp(join(__dirname, 'runtime'), join(resources, 'runtime'), { recursive: true });
  },
  asar: true,
  forceCodeSigning: process.env.RIVET_REQUIRE_SIGNING === '1',
  publish: [{ provider: 'github', owner: 'kartikg-gk', repo: 'rivet-code1' }],
  win: { target: ['nsis', 'portable'] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools' },
  linux: { target: ['AppImage', 'deb'], category: 'Development' },
};
