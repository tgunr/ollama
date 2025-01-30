const { AutoUnpackNativesPlugin } = require('@electron-forge/plugin-auto-unpack-natives');
const { WebpackPlugin } = require('@electron-forge/plugin-webpack');
const path = require('path');
const fs = require('fs');
const packageJson = require('./package.json');

const mainConfig = require('./webpack.main.config');
const rendererConfig = require('./webpack.renderer.config');

module.exports = {
  packagerConfig: {
    name: 'Ollama',
    executableName: 'Ollama',
    appVersion: process.env.VERSION || packageJson.version,
    icon: path.resolve(__dirname, 'assets/icon.icns'),
    asar: {
      unpack: '*.{node,dll}'
    },
    extraResource: [
      path.resolve(__dirname, '../ollama'),
      path.resolve(__dirname, 'assets/iconTemplate.png'),
      path.resolve(__dirname, 'assets/iconTemplate@2x.png'),
      path.resolve(__dirname, 'assets/iconDarkTemplate.png'),
      path.resolve(__dirname, 'assets/iconDarkTemplate@2x.png'),
      path.resolve(__dirname, 'assets/iconUpdateTemplate.png'),
      path.resolve(__dirname, 'assets/iconUpdateTemplate@2x.png'),
      path.resolve(__dirname, 'assets/iconDarkUpdateTemplate.png'),
      path.resolve(__dirname, 'assets/iconDarkUpdateTemplate@2x.png')
    ],
    appBundleId: 'com.ollama.app',
    osxSign: {
      identity: process.env.APPLE_IDENTITY,
      'hardened-runtime': true,
      'gatekeeper-assess': false,
      hardenedRuntime: true,
      entitlements: 'entitlements.plist',
      'entitlements-inherit': 'entitlements.plist',
      'signature-flags': 'library'
    },
    arch: 'arm64',
    platform: 'darwin',
    protocols: [
      {
        name: 'Ollama Protocol',
        schemes: ['ollama']
      }
    ]
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {
        name: 'Ollama',
        arch: 'arm64'
      }
    }
  ],
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
};
