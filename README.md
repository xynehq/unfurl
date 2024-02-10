# Unfurl
This project is a fork of [Unfurl.js](https://github.com/jacktuck/unfurl).
We wanted a way to run this in the browser, we do not face CORS issues as we are running it in the service worker of chrome extension.

## The what
Unfurl _(spread out from a furled state)_ will take a `url` and some `options`, fetch the `url`, extract the metadata we care about and format the result in a sane way. It supports all major metadata providers and expanding it to work for any others should be trivial.

## The why
So you know when you link to something on Slack, or Facebook, or Twitter - they typically show a preview of the link. To do so they have crawled the linked website for metadata and enriched the link by providing more context about it. Which usually entails grabbing its title, description and image/player embed.

## The how
```bash
npm install @xyne/unfurl
```

### `unfurl(url [, opts])`
#### url - `string`
---
#### opts - `object` of:
-  `oembed?: boolean` - support retrieving oembed metadata
-  `timeout?  number` - req/res timeout in ms, it resets on redirect. 10000 default
-  `follow?: number` - maximum redirect count. 0 to not follow redirect
-  `compress?: boolean` - support gzip/deflate content encoding
-  `size?: number` - maximum response body size in bytes. 0 to disable
-  `headers?: Headers | Record<string, string> | Iterable<readonly [string, string]> | Iterable<Iterable<string>>` - map of request headers, overrides the defaults

Default headers:
```
{
  'Accept': 'text/html, application/xhtml+xml',
  'User-Agent': 'facebookexternalhit'
}
```
---
#
```typescript
import { unfurl } from '@xyne/unfurl'
const result = unfurl('https://github.com/trending')
```
---
#### result is `<Promise<Metadata>>`
```typescript
type Metadata = {
  title?: string
  description?: string
  keywords?: string[]
  favicon?: string
  author?: string
  theme_color?: string
  canonical_url?: string
  oEmbed?: {
    type: 'photo' | 'video' | 'link' | 'rich'
    version?: string
    title?: string
    author_name?: string
    author_url?: string
    provider_name?: string
    provider_url?: string
    cache_age?: number
    thumbnails?: [{
      url?: string
      width?: number
      height?: number
    }]
  }
  twitter_card: {
    card: string
    site?: string
    creator?: string
    creator_id?: string
    title?: string
    description?: string
    players?: {
      url: string
      stream?: string
      height?: number
      width?: number
    }[]
    apps: {
      iphone: {
        id: string
        name: string
        url: string
      }
      ipad: {
        id: string
        name: string
        url: string
      }
      googleplay: {
        id: string
        name: string
        url: string
      }
    }
    images: {
      url: string
      alt: string
    }[]
  }
  open_graph: {
    title: string
    type: string
    images?: {
      url: string
      secure_url?: string
      type: string
      width: number
      height: number
      alt?: string
    }[]
    url?: string
    audio?: {
      url: string
      secure_url?: string
      type: string
    }[]
    description?: string
    determiner?: string
    site_name?: string
    locale: string
    locale_alt: string
    videos: {
      url: string
      stream?: string
      height?: number
      width?: number
      tags?: string[]
    }[]
    article: {
      published_time?: string
      modified_time?: string
      expiration_time?: string
      author?: string
      section?: string
      tags?: string[]
    }
  }
}
```
