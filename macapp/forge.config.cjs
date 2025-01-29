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
    name: 'Ollama',
    appVersion: process.env.VERSION || packageJson.version,
    asar: true,
    icon: './assets/icon',
    extraResource: [
      path.resolve(__dirname, '../ollama')
    ],
    osxSign: {
      entitlements: 'entitlements.plist',
      'entitlements-inherit': 'entitlements.plist',
      'gatekeeper-assess': false,
      hardenedRuntime: true,
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
              js: './src/preload.ts'
            }
          }
        ]
      }
    })
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
