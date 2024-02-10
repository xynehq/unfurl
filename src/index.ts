import { Parser } from "htmlparser2";
import UnexpectedError from "./unexpectedError";
import { schema, keys } from "./schema";
import { Metadata, Opts } from "./types";
import { decode as he_decode } from "he";

type ParserContext = {
  isHtml?: boolean;
  isOembed?: boolean;
  favicon?: string;
  text: string;
  title?: string;
  tagName?: string;
  canonical_url?: string;
};

const defaultHeaders = {
  Accept: "text/html, application/xhtml+xml",
  "User-Agent": "facebookexternalhit",
};

function unfurl(url: string, opts?: Opts): Promise<Metadata> {
  if (opts === undefined) {
    opts = {};
  }

  if (opts.constructor.name !== "Object") {
    throw new UnexpectedError(UnexpectedError.BAD_OPTIONS);
  }

  typeof opts.oembed === "boolean" || (opts.oembed = true);
  typeof opts.compress === "boolean" || (opts.compress = true);
  typeof opts.headers === "object" || (opts.headers = defaultHeaders);

  Number.isInteger(opts.follow) || (opts.follow = 50);
  Number.isInteger(opts.timeout) || (opts.timeout = 10000);
  Number.isInteger(opts.size) || (opts.size = 0);

  return getPage(url, opts)
    .then(getMetadata(url, opts))
    .then(getRemoteMetadata(url, opts))
    .then(parse(url));
}

async function getPage(url, opts) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeout);

  const res = await (opts.fetchFn
    ? opts.fetchFn(url)
    : fetch(url, {
        headers: opts.headers,
        signal: controller.signal,
      }));
  clearTimeout(timeoutId);

  if (res.status !== 200) {
    throw new Error(`Unexpected HTTP status: ${res.status}`);
  }

  const contentType = res.headers.get("Content-Type");
  if (!/text\/html|application\/xhtml+xml/.test(contentType)) {
    throw new Error(`Expected HTML content, got ${contentType}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  const initialText = new TextDecoder("utf-8", { fatal: false }).decode(
    arrayBuffer
  );

  // Attempt to detect charset from meta tags
  const charsetMatch =
    initialText.match(/<meta\s+charset=["']?([^"'>]+)/i) ||
    initialText.match(
      /<meta\s+http-equiv=["']?Content-Type["']?\s+content=["']text\/html;\s+charset=([^"'>]+)/i
    );

  if (charsetMatch && charsetMatch[1].toUpperCase() !== "UTF-8") {
    // Re-decode with detected charset if it's different from UTF-8
    try {
      const decoder = new TextDecoder(charsetMatch[1], { fatal: true });
      return decoder.decode(arrayBuffer);
    } catch (error) {
      console.warn(
        `Decoding with charset ${charsetMatch[1]} failed, falling back to UTF-8.`,
        error
      );
      // Fallback to UTF-8 if the detected charset is not supported
      return initialText;
    }
  }

  return initialText;
}

function getRemoteMetadata(url: string, { fetchFn }: Opts) {
  return async function ({ oembed, metadata }) {
    if (!oembed) {
      return metadata;
    }

    const target = new URL(he_decode(oembed.href), url);

    let res = await fetchFn(target.href);
    let contentType = res.headers.get("Content-Type");
    const status = res.status;

    if (status === 403 && target.protocol === "http:") {
      // try again using HTTPS
      target.protocol = "https:";

      res = await fetchFn(target.href);
      contentType = res.headers.get("Content-Type");
    }

    let ret;

    if (
      oembed.type === "application/json+oembed" &&
      /application\/json/.test(contentType)
    ) {
      ret = await res.json();
    } else if (
      oembed.type === "text/xml+oembed" &&
      /(text|application)\/xml/.test(contentType)
    ) {
      const data = (await res.text())
        .replace(/&gt;/g, ">")
        .replace(/&lt;/g, "<");

      const content: { [key: string]: string } = {};

      const parserContext: ParserContext = { text: "" };

      ret = await new Promise((resolve) => {
        const parser = new Parser(
          {
            oncdataend: () => {
              if (
                !content.html &&
                parserContext.text.trim().startsWith("<") &&
                parserContext.text.trim().endsWith(">")
              ) {
                content.html = parserContext.text.trim();
              }
            },
            // eslint-disable-next-line
            onopentag: function (name: string, attribs: any) {
              if (parserContext.isHtml) {
                if (!content.html) {
                  content.html = "";
                }

                content.html += `<${name} `;
                content.html += Object.keys(attribs)
                  .reduce(
                    (str, k) =>
                      str +
                      (attribs[k] ? `${k}="${attribs[k]}"` : `${k}`) +
                      " ",
                    ""
                  )
                  .trim();
                content.html += ">";
              }

              if (name === "html") {
                parserContext.isHtml = true;
              }

              parserContext.tagName = name;
            },
            ontext: function (text: string) {
              parserContext.text += text;
            },
            onclosetag: function (tagname: string) {
              if (tagname === "oembed") {
                return;
              }

              if (tagname === "html") {
                parserContext.isHtml = false;
                return;
              }

              if (parserContext.isHtml) {
                content.html += parserContext.text.trim();
                content.html += `</${tagname}>`;
              }

              content[tagname] = parserContext.text.trim();

              parserContext.tagName = "";
              parserContext.text = "";
            },
            onend: function () {
              resolve(content);
            },
          },
          {
            recognizeCDATA: true,
          }
        );

        parser.write(data);
        parser.end();
      });
    }

    if (!ret) {
      return metadata;
    }

    const oEmbedMetadata = Object.keys(ret)
      .map((k) => ["oEmbed:" + k, ret[k]])
      .filter(([k]) => keys.includes(String(k)));

    metadata.push(...oEmbedMetadata);
    return metadata;
  };
}

function getMetadata(url: string, opts: Opts) {
  return function (text: string) {
    const metadata = [];
    const parserContext: ParserContext = { text: "" };

    let oembed: { type?: string; href?: string };
    let distanceFromRoot = 0;

    return new Promise((resolve) => {
      const parser = new Parser({
        onend: function () {
          if (parserContext.favicon === undefined) {
            metadata.push(["favicon", new URL("/favicon.ico", url).href]);
          } else {
            metadata.push([
              "favicon",
              new URL(parserContext.favicon, url).href,
            ]);
          }

          if (parserContext.canonical_url) {
            metadata.push([
              "canonical_url",
              new URL(parserContext.canonical_url, url).href,
            ]);
          }

          resolve({ oembed, metadata });
        },

        onopentagname: function (tag: string) {
          parserContext.tagName = tag;
        },

        ontext: function (text: string) {
          if (parserContext.tagName === "title") {
            // makes sure we haven't already seen the title
            if (parserContext.title !== null) {
              if (parserContext.title === undefined) {
                parserContext.title = "";
              }

              parserContext.title += text;
            }
          }
        },

        onopentag: function (
          tagname: string,
          attribs: { [key: string]: string }
        ) {
          distanceFromRoot++;

          if (opts.oembed && attribs.href) {
            // handle XML and JSON with a preference towards JSON since its more efficient for us
            if (
              tagname === "link" &&
              (attribs.type === "text/xml+oembed" ||
                attribs.type === "application/json+oembed")
            ) {
              if (!oembed || oembed.type === "text/xml+oembed") {
                // prefer json
                oembed = attribs;
              }
            }
          }
          if (
            tagname === "link" &&
            attribs.href &&
            (attribs.rel === "icon" || attribs.rel === "shortcut icon")
          ) {
            parserContext.favicon = attribs.href;
          }

          if (
            tagname === "link" &&
            attribs.href &&
            attribs.rel === "canonical"
          ) {
            parserContext.canonical_url = attribs.href;
          }

          let pair: [string, string | string[]];

          if (tagname === "meta") {
            if (attribs.name === "description" && attribs.content) {
              pair = ["description", attribs.content];
            } else if (attribs.name === "author" && attribs.content) {
              pair = ["author", attribs.content];
            } else if (attribs.name === "theme-color" && attribs.content) {
              pair = ["theme_color", attribs.content];
            } else if (attribs.name === "keywords" && attribs.content) {
              const keywords = attribs.content
                .replace(/^[,\s]{1,}|[,\s]{1,}$/g, "") // gets rid of trailing space or sommas
                .split(/,{1,}\s{0,}/); // splits on 1+ commas followed by 0+ spaces

              pair = ["keywords", keywords];
            } else if (attribs.property && keys.includes(attribs.property)) {
              const content = attribs.content || attribs.value;
              pair = [attribs.property, content];
            } else if (attribs.name && keys.includes(attribs.name)) {
              const content = attribs.content || attribs.value;
              pair = [attribs.name, content];
            }
          }

          if (pair) {
            metadata.push(pair);
          }
        },

        onclosetag: function (tag: string) {
          distanceFromRoot--;
          parserContext.tagName = "";

          if (distanceFromRoot <= 2 && tag === "title") {
            metadata.push(["title", parserContext.title]);
            parserContext.title = "";
          }

          // We want to parse as little as possible so finish once we see </head>
          // if we have not seen a title tag within the head, we scan the entire
          // document instead
          if (tag === "head" && parserContext.title) {
            parser.reset();
          }
        },
      });

      parser.write(text);
      parser.end();
    });
  };
}

function parse(url: string) {
  return function (metadata) {
    // eslint-disable-next-line
    const parsed: any = {};
    const ogVideoTags = [];
    const articleTags = [];

    let lastParent;

    for (const meta of metadata) {
      const metaKey = meta[0];
      let metaValue = meta[1];

      const item = schema.get(metaKey);

      // decoding html entities
      if (typeof metaValue === "string") {
        metaValue = he_decode(he_decode(metaValue.toString()));
      } else if (Array.isArray(metaValue)) {
        metaValue = metaValue.map((val) => he_decode(he_decode(val)));
      }

      if (!item) {
        parsed[metaKey] = metaValue;
        continue;
      }

      // special case for video tags which we want to map to each video object
      if (metaKey === "og:video:tag") {
        ogVideoTags.push(metaValue);
        continue;
      }
      if (metaKey === "article:tag") {
        articleTags.push(metaValue);
        continue;
      }

      if (item.type === "number") {
        metaValue = parseInt(metaValue, 10);
      } else if (item.type === "url" && metaValue) {
        metaValue = new URL(metaValue, url).href;
      }

      if (parsed[item.entry] === undefined) {
        parsed[item.entry] = {};
      }

      let target = parsed[item.entry];

      if (item.parent) {
        if (item.category) {
          if (!target[item.parent]) {
            target[item.parent] = {};
          }

          if (!target[item.parent][item.category]) {
            target[item.parent][item.category] = {};
          }

          target = target[item.parent][item.category];
        } else {
          if (Array.isArray(target[item.parent]) === false) {
            target[item.parent] = [];
          }

          if (!target[item.parent][target[item.parent].length - 1]) {
            target[item.parent].push({});
          } else if (
            (!lastParent || item.parent === lastParent) &&
            target[item.parent][target[item.parent].length - 1] &&
            target[item.parent][target[item.parent].length - 1][item.name]
          ) {
            target[item.parent].push({});
          }

          lastParent = item.parent;
          target = target[item.parent][target[item.parent].length - 1];
        }
      }

      // some fields map to the same name so once we have one stick with it
      target[item.name] || (target[item.name] = metaValue);
    }

    if (ogVideoTags.length && parsed.open_graph.videos) {
      parsed.open_graph.videos = parsed.open_graph.videos.map((obj) => ({
        ...obj,
        tags: ogVideoTags,
      }));
    }
    if (articleTags.length && parsed.open_graph.articles) {
      parsed.open_graph.articles = parsed.open_graph.articles.map((obj) => ({
        ...obj,
        tags: articleTags,
      }));
    }

    return parsed;
  };
}

export { unfurl };
