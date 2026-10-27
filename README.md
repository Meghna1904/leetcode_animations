# leetcode_animations

A personal DSA hub with a browsable question-pattern list, solve tracking, spaced-repetition reviews, and a collection of interactive HTML animations.

## Run locally

```sh
npm install
npm run dev
```

## Build for deployment

```sh
npm run build
```

The production site is generated in `dist/`. On Vercel, use `npm run build` as the build command and `dist` as the output directory if they are not detected automatically.

Animation entries are stored in this browser's localStorage. They persist on the deployed domain in that browser and do not sync between devices.
