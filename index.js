#!/usr/bin/env node

const yargs = require('yargs')
const prompts = require('prompts')
const axios = require('axios')
const uuid = require('uuid')
const FormData = require('form-data')

const sanitize = require('sanitize-filename')
const ffmpeg = require('fluent-ffmpeg')
const m3u8Parser = require('m3u8-parser')

const { info, warn, error } = require('./lib/log')
const bar = require('./lib/bar')

let argv = yargs
  .usage('Usage: $0 [options]')

  // login
  .describe('username', 'Your username or email')
  .alias('u', 'username')
  .describe('password', 'Your password')
  .alias('p', 'password')

  // input
  .describe('input', 'The URL for the Crunchyroll show')
  .alias('i', 'input')

  .describe('quality', 'The quality of the stream')
  .choices('quality', ['240p', '480p', '720p', '1080p', 'best'])
  .default('quality', 'best', 'The best quality')
  .alias('q', 'quality')

  .describe('language', 'The language of the episode subtitles')
  .default('language', 'enUS')
  .alias('l', 'language')

  // output
  .describe('output', 'The output of the file for the video file')
  .default('output', ':name Episode :ep [:resolution]')
  .alias('o', 'output')

  .describe('unblocked', 'Use the USA library of Crunchyroll')
  .boolean('unblocked')

  // help
  .describe('h', 'Shows this help')
  .alias('h', 'help')
  .boolean('h')

  .demandOption(['input'], 'Please specify an input')
  .help()
  .version(false)
  .argv

let sessionId = null
let authed = false
let premium = false

// instance for further crunchyroll requests
const instance = axios.create({
  baseURL: 'https://api.crunchyroll.com/'
})

// some default params
const baseParams = {
  locale: 'enUS',
  version: '2.1.6'
}

const main = async () => {
  const { input, username, password, language, quality, unblocked } = argv

  // source from https://github.com/Xonshiz/anime-dl/blob/master/anime_dl/sites/crunchyroll.py#L40-L41
  const seriesRegex = /https?:\/\/(?:(www|m)\.)?(crunchyroll\.com\/([\w\-]+))\/?(?:\?|$)/
  const episodeRegex = /https?:\/\/(?:(www|m)\.)?(crunchyroll\.(?:com|fr)\/(?:media(?:-|\/\?id=)|[^/]*\/[^/?&]*?)([0-9]+))(?:[/?&]|$)/

  let series = seriesRegex.test(input)
  let episode = episodeRegex.test(input)
  if (!series && !episode) {
    error('Invalid Crunchyroll URL input')
    process.exit(1)
  }

  authed = username && password

  if (unblocked && !authed) {
    error('You must be logged in to unblock yourself.')
    process.exit(1)
  }

  // start session
  const { data: { data: sessionData } } = await crunchyrollRequest('get', 'start_session.0.json', {
    params: {
      access_token: 'Scwg9PRRZ19iVwD',
      device_type: 'com.crunchyroll.crunchyroid',
      device_id: uuid(),
      ...baseParams
    }
  })

  sessionId = sessionData.session_id
    
  if (authed) {
    info('Attempting to login...')
    // login
    const loginForm = new FormData()
    loginForm.append('account', argv.username)
    loginForm.append('password', argv.password)
    loginForm.append('session_id', sessionId)
    loginForm.append('locale', baseParams.locale)
    loginForm.append('version', baseParams.version)

    const loginResponse = await crunchyrollRequest('post', 'login.0.json', loginForm, {
      headers: loginForm.getHeaders()
    })
    
    if (loginResponse.data.error) {
      error(loginResponse.data.message)
      process.exit(1)
    }
    info('Successfully logged in!')

    if (loginResponse.data.data.user.premium.includes('anime')) {
      info('Logged in with a premium account.')
      premium = true
    }

    if (unblocked) {
      try {
        const unblockedSession = await axios.get('https://api2.cr-unblocker.com/start_session', {
          params: {
            auth: loginResponse.data.data.auth,
            version: '1.1',
            user_id: loginResponse.data.data.user.user_id
          }
        })
        
        if (unblockedSession) {
          await cleanup(true, false, false) // logout of old session
          info('Successfully initiated USA Crunchyroll session')
          sessionId = unblockedSession.data.data.session_id
        }
      } catch (e) {
        error('Something went wrong when creating an unblocked session.')
        process.exit(1)
      }
    }
  }

  const getEpisode = async (mediaId, epData = null) => {
    info('Attempting to fetch episode...')
    const episodeStreams = await crunchyrollRequest('get', 'info.0.json', {
      params: {
        session_id: sessionId,
        fields: 'media.stream_data,media.media_id',
        media_id: mediaId,
        locale: language,
        ...baseParams
      }
    })
    
    if (episodeStreams.data.error) {
      error(episodeStreams.data.message)
    } else {
      const streams = episodeStreams.data.data.stream_data.streams

      // fetch data about the episode if needed
      let episodeData = epData
      if (!episodeData) {
        let { data: { data: episodeTempData } } = await crunchyrollRequest('get', 'info.0.json', {
          params: {
            session_id: sessionId,
            fields: 'media.media_id,media.collection_id,media.collection_name,media.series_id,media.episode_number,media.name,media.description,media.premium_only',
            media_id: mediaId,
            locale: language,
            ...baseParams
          }
        })
        episodeData = episodeTempData
      }

      if (episodeData.premium_only && !premium) {
        warn(`Skipping "${episodeData.name}" due to it being for premium members only. (Ep ${episodeData.episode_number})`)
        return
      }

      const qualityMap = {
        'low': '240p',
        'mid': '480p',
        'high': '720p',
        'ultra': '1080p'
      }
      let qualityId = Object.keys(qualityMap).find((key) => qualityMap[key] === quality)

      // check for the specified quality, if it is specified in the return, it should be in the m3u8...
      // they appear to all be the same stream now
      let qualityObj = streams.find((stream) => stream.quality === qualityId)

      if (quality === 'best') {
        qualityObj = streams[streams.length - 1] // last one
      }

      if (!qualityObj) {
        error(`Specified quality not found (${quality})`)
        if (streams.length === 0) {
          warn('You may not have access to watch this episode')
        }
        return
      }

      qualityResolution = qualityMap[qualityObj.quality] // get resolution

      let output = argv.output
        .replace(':name', episodeData.collection_name)
        .replace(':epname', episodeData.name)
        .replace(':ep', episodeData.episode_number || '')
        .replace(':resolution', qualityResolution)
      output = `${sanitize(output)}.mp4`
      info(`Downloading episode as "${output}"`)

      // download from the adaptive stream
      const adaptiveStream = streams[0].url

      const m3u8 = await axios.get(adaptiveStream) // fetch the m3u8
      const m3u8Data = parsem3u8(m3u8.data)

      if (m3u8Data.playlists.length) {
        const resolution = Number(qualityResolution.replace('p', '')) // get the actual resolution wanted as a number
        
        for (let playlist of m3u8Data.playlists) {
          // only download the v.vrv.co url
          if (playlist['attributes']['RESOLUTION']['height'] === resolution && playlist['uri'].startsWith('https://v.vrv.co')) {
            await downloadEpisode(playlist['uri'], output)
            return
          }
        }
        warn('The resolution specified was not found.')
      } else {
        warn('No streams found.')
      }
    }
  }

  if (episode) {
    let match = input.match(episodeRegex)
    let mediaId = match[3] // the match group

    await getEpisode(mediaId)
  }

  if (series) {
    info('Attempting to fetch series...')
    let match = input.match(seriesRegex)
    
    // grab the page
    let page = null
    try {
      page = await axios.get(input)
    } catch (e) {
      error(`Error fetching series: ${e.message || 'Something went wrong'}`)
      await cleanup()
    }
    const idDivRegex = /<div class="show-actions" group_id="(.*)"><\/div>/ // search for a div with an id

    const seriesId = page.data.match(idDivRegex)[1]
    if (!seriesId) {
      error('Series not found')
      await cleanup()
    }

    // grab the show info
    const { data: { data: seriesInfo } } = await crunchyrollRequest('get', 'info.0.json', {
      params: {
        session_id: sessionId,
        series_id: seriesId,
        fields: 'series.series_id,series.name,series.description,series.media_count',
        locale: language,
        ...baseParams
      }
    })

    // grab the collections for the show
    const { data: { data: collections } } = await crunchyrollRequest('get', 'list_collections.0.json', {
      params: {
        session_id: sessionId,
        series_id: seriesId,
        limit: 1000,
        offset: 0
      }
    })

    let choices = collections.map((collection) => ({title: collection.name, value: collection.collection_id}))

    const { value: selectedCollections = [] } = await prompts({
      type: 'multiselect',
      name: 'value',
      message: 'Which collections would you like to download?',
      choices,
      hint: '- Space to select. Return to submit'
    })

    for (let collection of selectedCollections) {
      const collectionName = collections.find((col) => col.collection_id === collection).name

      let { data: { data: collectionMedia } } = await crunchyrollRequest('get', 'list_media.0.json', {
        params: {
          session_id: sessionId,
          collection_id: collection,
          limit: 1000,
          offset: 0,
          fields: 'media.media_id,media.collection_id,media.collection_name,media.series_id,media.episode_number,media.name,media.description,media.premium_only',
          ...baseParams
        }
      })
      info(`Beginning to download "${collectionName}"`)
      for (let media of collectionMedia) {
        info(`Downloading episode ${media.episode_number || '(not set)'}, "${media.name}", of "${collectionName}"`)
        await getEpisode(media.media_id, media)
      }
    }
  }

  info('Done!')
  await cleanup()
}

const cleanup = async (logout = true, exit = true, log = true) => {
  if (authed && logout) {
    if (log) {
      info('Logging out...')
    }
    // logout
    const logoutForm = new FormData()
    logoutForm.append('session_id', sessionId)
    logoutForm.append('locale', baseParams.locale)
    logoutForm.append('version', baseParams.version)

    await crunchyrollRequest('post', 'logout.0.json', logoutForm, {
      headers: logoutForm.getHeaders()
    })
  }
  if (exit) {
    process.exit(1)
  }
}

process.on('SIGINT', async () => {
  await cleanup()
})

const crunchyrollRequest = async (method, ...args) => {
  try {
    return await instance[method](...args)
  } catch (e) {
    error('Something went wrong when contacting Crunchyroll. They may be down.')
    process.exit(1)
  }
}

const parsem3u8 = (manifest) => {
  let parser = new m3u8Parser.Parser()

  parser.push(manifest)
  parser.end()
  return parser.manifest
}

const downloadEpisode = (url, output) => {
  return new Promise((resolve, reject) => {
    ffmpeg(url)
      .on('start', () => {
        info('Beginning download...')
      })
      .on('progress', function(progress) {
        bar((progress.percent || 0).toFixed(2), progress.currentFps, progress.timemark)
      })
      .on('error', error => {
        reject(new Error(error))
      })
      .on('end', () => {
        process.stderr.write('\n') // newline
        info(`Successfully downloaded "${output}"`)
        resolve()
      })
      .outputOptions('-c copy')
      .output(output)
      .run()
  })
}

main()
