const { AutoUnpackNativesPlugin } = require('@electron-forge/plugin-auto-unpack-natives');
const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const path = require('path');
const fs = require('fs');

const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, './package.json'), 'utf8'));

// Note: These configs might need to be adjusted if they use ES modules
const mainConfig = require('./webpack.main.config');
const rendererConfig = require('./webpack.renderer.config');

module.exports = {
  packagerConfig: {
    appVersion: process.env.VERSION || packageJson.version,
    asar: true,
    icon: './assets/icon.icns',
    extraResource: [
      '../dist/ollama',
      path.join(__dirname, './assets/iconTemplate.png'),
      path.join(__dirname, './assets/iconTemplate@2x.png'),
      path.join(__dirname, './assets/iconUpdateTemplate.png'),
      path.join(__dirname, './assets/iconUpdateTemplate@2x.png'),
      path.join(__dirname, './assets/iconDarkTemplate.png'),
      path.join(__dirname, './assets/iconDarkTemplate@2x.png'),
    ],
  },
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new WebpackPlugin({
      mainConfig,
      renderer: {
        config: rendererConfig,
        entryPoints: [
          {
            html: './src/index.html',
            js: './src/renderer.tsx',
            name: 'main_window',
            preload: {
              js: './src/preload.ts',
            },
          },
        ],
      },
    }),
  ],
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'ollama',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
  ],
  publishers: [
    {
      name: '@electron-forge/publisher-github',
      config: {
        repository: {
          owner: 'jmorganca',
          name: 'ollama',
        },
        prerelease: false,
        draft: true,
      },
    },
  ],
};
