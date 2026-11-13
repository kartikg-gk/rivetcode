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
  publish: [{ provider: 'github', owner: 'kartikg-gk', repo: 'rivetcode' }],
  win: { target: ['nsis', 'portable'] },
  // File names without spaces, the same as latest.yml names them, so an upload by hand still updates.
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, artifactName: 'Rivet-Setup-${version}.${ext}' },
  portable: { artifactName: 'Rivet-${version}-portable.${ext}' },
  dmg: { artifactName: 'Rivet-${version}-${arch}.${ext}' },
  appImage: { artifactName: 'Rivet-${version}-${arch}.${ext}' },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.developer-tools' },
  // A .deb names a maintainer; the GitHub no-reply address keeps a personal one out of it.
  linux: { target: ['AppImage', 'deb'], category: 'Development', maintainer: 'kartikg-gk <kartikg-gk@users.noreply.github.com>' },
};
