import _ from "lodash"
import path from "path"
import fs from "fs-extra"
import crypto from "crypto"
import { slash } from "gatsby-core-utils"
import reporter from "gatsby-cli/lib/reporter"
import { match } from "@gatsbyjs/reach-router/lib/utils"
import { joinPath } from "gatsby-core-utils"
import { store, emitter } from "../redux/"
import { IGatsbyState, IGatsbyPage } from "../redux/types"
import {
  writeModule,
  getAbsolutePathForVirtualModule,
} from "../utils/gatsby-webpack-virtual-modules"
import { getPageMode } from "../utils/page-mode"
import { devSSRWillInvalidate } from "../commands/build-html"

interface IGatsbyPageComponent {
  component: string
  componentChunkName: string
}

interface IGatsbyPageMatchPath {
  path: string
  matchPath: string | undefined
}

// path ranking algorithm copied (with small adjustments) from `@reach/router` (internal util, not exported from the package)
// https://github.com/reach/router/blob/28a79e7fc3a3487cb3304210dc3501efb8a50eba/src/lib/utils.js#L216-L254
const paramRe = /^:(.+)/

const SEGMENT_POINTS = 4
const STATIC_POINTS = 3
const DYNAMIC_POINTS = 2
const SPLAT_PENALTY = 1
const ROOT_POINTS = 1

const isRootSegment = (segment: string): boolean => segment === ``
const isDynamic = (segment: string): boolean => paramRe.test(segment)
const isSplat = (segment: string): boolean => segment === `*`

const segmentize = (uri: string): Array<string> =>
  uri
    // strip starting/ending slashes
    .replace(/(^\/+|\/+$)/g, ``)
    .split(`/`)

const rankRoute = (path: string): number =>
  segmentize(path).reduce((score, segment) => {
    score += SEGMENT_POINTS
    if (isRootSegment(segment)) score += ROOT_POINTS
    else if (isDynamic(segment)) score += DYNAMIC_POINTS
    else if (isSplat(segment)) score -= SEGMENT_POINTS + SPLAT_PENALTY
    else score += STATIC_POINTS
    return score
  }, 0)
// end of copied `@reach/router` internals

let lastHash: string | null = null

export const resetLastHash = (): void => {
  lastHash = null
}

const pickComponentFields = (page: IGatsbyPage): IGatsbyPageComponent =>
  _.pick(page, [`component`, `componentChunkName`])

export const getComponents = (
  pages: Array<IGatsbyPage>
): Array<IGatsbyPageComponent> =>
  _.orderBy(
    _.uniqBy(_.map(pages, pickComponentFields), c => c.componentChunkName),
    c => c.componentChunkName
  )

/**
 * Get all dynamic routes and sort them by most specific at the top
 * code is based on @reach/router match utility (https://github.com/reach/router/blob/152aff2352bc62cefc932e1b536de9efde6b64a5/src/lib/utils.js#L224-L254)
 */
const getMatchPaths = (
  pages: Array<IGatsbyPage>
): Array<IGatsbyPageMatchPath> => {
  interface IMatchPathEntry extends IGatsbyPage {
    index: number
    score: number
    matchPath: string
  }

  const createMatchPathEntry = (
    page: IGatsbyPage,
    index: number
  ): IMatchPathEntry => {
    const { matchPath } = page

    if (matchPath === undefined) {
      return reporter.panic(
        `Error: matchPath property is undefined for page ${page.path}, should be a string`
      ) as never
    }

    return {
      ...page,
      matchPath,
      index,
      score: rankRoute(matchPath),
    }
  }

  const matchPathPages: Array<IMatchPathEntry> = []

  pages.forEach((page: IGatsbyPage, index: number): void => {
    if (_CFLAGS_.GATSBY_MAJOR === `4`) {
      if (page.matchPath && getPageMode(page) === `SSG`) {
        matchPathPages.push(createMatchPathEntry(page, index))
      }
    } else {
      if (page.matchPath) {
        matchPathPages.push(createMatchPathEntry(page, index))
      }
    }
  })

  // Pages can live in matchPaths, to keep them working without doing another network request
  // we save them in matchPath. We use `@reach/router` path ranking to score paths/matchPaths
  // and sort them so more specific paths are before less specific paths.
  // More info in https://github.com/gatsbyjs/gatsby/issues/16097
  // small speedup: don't bother traversing when no matchPaths found.
  if (matchPathPages.length) {
    const newMatches: Array<IMatchPathEntry> = []

    pages.forEach((page: IGatsbyPage, index: number): void => {
      const isInsideMatchPath = !!matchPathPages.find(
        pageWithMatchPath =>
          !page.matchPath && match(pageWithMatchPath.matchPath, page.path)
      )

      if (isInsideMatchPath) {
        newMatches.push(
          createMatchPathEntry(
            {
              ...page,
              matchPath: page.path,
            },
            index
          )
        )
      }
    })
    // Add afterwards because the new matches are not relevant for the existing search
    matchPathPages.push(...newMatches)
  }

  return matchPathPages
    .sort((a, b) => {
      // The higher the score, the higher the specificity of our matchPath
      const order = b.score - a.score
      if (order !== 0) {
        return order
      }

      // if specificity is the same we do lexigraphic comparison of path to ensure
      // deterministic order regardless of order pages where created
      return a.matchPath.localeCompare(b.matchPath)
    })
    .map(({ path, matchPath }) => {
      return { path, matchPath }
    })
}

const createHash = (
  matchPaths: Array<IGatsbyPageMatchPath>,
  components: Array<IGatsbyPageComponent>,
  cleanedSSRVisitedPageComponents: Array<IGatsbyPageComponent>
): string =>
  crypto
    .createHash(`md5`)
    .update(
      JSON.stringify({
        matchPaths,
        components,
        cleanedSSRVisitedPageComponents,
      })
    )
    .digest(`hex`)

// Write out pages information.
export const writeAll = async (state: IGatsbyState): Promise<boolean> => {
  const { program } = state
  const pages = [...state.pages.values()]
  const matchPaths = getMatchPaths(pages)
  const components = getComponents(pages)
  let cleanedSSRVisitedPageComponents: Array<IGatsbyPageComponent> = []

  if (process.env.GATSBY_EXPERIMENTAL_DEV_SSR) {
    const ssrVisitedPageComponents = [
      ...(state.visitedPages.get(`server`)?.values() || []),
    ]

    // Remove any page components that no longer exist.
    cleanedSSRVisitedPageComponents = components.filter(c =>
      ssrVisitedPageComponents.some(s => s === c.componentChunkName)
    )
  }

  const newHash = createHash(
    matchPaths,
    components,
    cleanedSSRVisitedPageComponents
  )

  if (newHash === lastHash) {
    // Nothing changed. No need to rewrite files
    return false
  }

  lastHash = newHash

  if (process.env.GATSBY_EXPERIMENTAL_DEV_SSR) {
    // Create file with sync requires of visited page components files.

    const lazySyncRequires = `exports.ssrComponents = {\n${cleanedSSRVisitedPageComponents
      .map(
        (c: IGatsbyPageComponent): string =>
          `  "${c.componentChunkName}": require("${joinPath(c.component)}")`
      )
      .join(`,\n`)}
  }\n\n`

    writeModule(`$virtual/ssr-sync-requires`, lazySyncRequires)
    // if this is executed, webpack should mark it as invalid, but sometimes there is some timing race
    // so we also explicitly set flag here as well
    devSSRWillInvalidate()
  }

  // Create file with sync requires of components/json files.
  let syncRequires = `
// prefer default export if available
const preferDefault = m => (m && m.default) || m
\n\n`
  syncRequires += `exports.components = {\n${components
    .map(
      (c: IGatsbyPageComponent): string =>
        `  "${c.componentChunkName}": preferDefault(require("${joinPath(
          c.component
        )}"))`
    )
    .join(`,\n`)}
}\n\n`

  // Create file with async requires of components/json files.
  let asyncRequires = ``

  if (process.env.gatsby_executing_command === `develop`) {
    asyncRequires = `exports.components = {\n${components
      .map((c: IGatsbyPageComponent): string => {
        // we need a relative import path to keep contenthash the same if directory changes
        const relativeComponentPath = path.relative(
          getAbsolutePathForVirtualModule(`$virtual`),
          c.component
        )

        return `  "${c.componentChunkName}": () => import("${slash(
          `./${relativeComponentPath}`
        )}?export=default" /* webpackChunkName: "${c.componentChunkName}" */)`
      })
      .join(`,\n`)}
}\n\n

exports.head = {\n${components
      .map((c: IGatsbyPageComponent): string => {
        // we need a relative import path to keep contenthash the same if directory changes
        const relativeComponentPath = path.relative(
          getAbsolutePathForVirtualModule(`$virtual`),
          c.component
        )

        return `  "${c.componentChunkName}": () => import("${slash(
          `./${relativeComponentPath}`
        )}?export=head" /* webpackChunkName: "${c.componentChunkName}head" */)`
      })
      .join(`,\n`)}
}\n\n`
  } else {
    asyncRequires = `exports.components = {\n${components
      .map((c: IGatsbyPageComponent): string => {
        // we need a relative import path to keep contenthash the same if directory changes
        const relativeComponentPath = path.relative(
          getAbsolutePathForVirtualModule(`$virtual`),
          c.component
        )
        return `  "${c.componentChunkName}": () => import("${slash(
          `./${relativeComponentPath}`
        )}" /* webpackChunkName: "${c.componentChunkName}" */)`
      })
      .join(`,\n`)}
}\n\n`
  }

  const writeAndMove = (
    virtualFilePath: string,
    file: string,
    data: string
  ): Promise<void> => {
    writeModule(virtualFilePath, data)

    // files in .cache are not used anymore as part of webpack builds, but
    // still can be used by other tools (for example `gatsby serve` reads
    // `match-paths.json` to setup routing)
    const destination = joinPath(program.directory, `.cache`, file)
    const tmp = `${destination}.${Date.now()}`
    return fs
      .writeFile(tmp, data)
      .then(() => fs.move(tmp, destination, { overwrite: true }))
  }

  await Promise.all([
    writeAndMove(`$virtual/sync-requires.js`, `sync-requires.js`, syncRequires),
    writeAndMove(
      `$virtual/async-requires.js`,
      `async-requires.js`,
      asyncRequires
    ),
    writeAndMove(
      `$virtual/match-paths.json`,
      `match-paths.json`,
      JSON.stringify(matchPaths, null, 4)
    ),
  ])

  return true
}

const debouncedWriteAll = _.debounce(
  async (): Promise<void> => {
    const activity = reporter.activityTimer(`write out requires`, {
      id: `requires-writer`,
    })
    activity.start()
    await writeAll(store.getState())
    activity.end()
  },
  500,
  {
    // using "leading" can cause double `writeAll` call - particularly
    // when refreshing data using `/__refresh` hook.
    leading: false,
  }
)

/**
 * Start listening to CREATE/DELETE_PAGE events so we can rewrite
 * files as required
 */
let listenerStarted = false
export const startListener = (): void => {
  // Only start the listener once.
  if (listenerStarted) {
    return
  }
  listenerStarted = true

  if (process.env.GATSBY_EXPERIMENTAL_DEV_SSR) {
    /**
     * Start listening to CREATE_SERVER_VISITED_PAGE events so we can rewrite
     * files as required
     */
    emitter.on(`CREATE_SERVER_VISITED_PAGE`, async (): Promise<void> => {
      // this event only happen on new additions
      devSSRWillInvalidate()
      reporter.pendingActivity({ id: `requires-writer` })
      debouncedWriteAll()
    })
  }

  emitter.on(`CREATE_PAGE`, (): void => {
    reporter.pendingActivity({ id: `requires-writer` })
    debouncedWriteAll()
  })

  emitter.on(`CREATE_PAGE_END`, (): void => {
    reporter.pendingActivity({ id: `requires-writer` })
    debouncedWriteAll()
  })

  emitter.on(`DELETE_PAGE`, (): void => {
    reporter.pendingActivity({ id: `requires-writer` })
    debouncedWriteAll()
  })

  emitter.on(`DELETE_PAGE_BY_PATH`, (): void => {
    reporter.pendingActivity({ id: `requires-writer` })
    debouncedWriteAll()
  })
}
