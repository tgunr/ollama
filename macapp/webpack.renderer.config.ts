import type { Configuration } from 'webpack'

import { rules } from './webpack.rules.ts'
import { plugins } from './webpack.plugins.ts'

rules.push({
  test: /\.css$/,
  use: [{ loader: 'style-loader' }, { loader: 'css-loader' }, { loader: 'postcss-loader' }],
})

rules.push({
  test: /\.svg$/,
  use: ['@svgr/webpack'],
})

export const rendererConfig: Configuration = {
  module: {
    rules,
  },
  plugins,
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.css'],
    fallback: {
      "path": require.resolve("path-browserify"),
      "util": require.resolve("util/"),
      "crypto": require.resolve("crypto-browserify"),
      "assert": require.resolve("assert/"),
      "os": require.resolve("os-browserify/browser"),
      "fs": false,
      "child_process": false
    }
  },
}
