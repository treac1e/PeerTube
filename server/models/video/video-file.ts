import { remove } from 'fs-extra'
import memoizee from 'memoizee'
import { join } from 'path'
import { FindOptions, Op, Transaction, WhereOptions } from 'sequelize'
import {
  AllowNull,
  BelongsTo,
  Column,
  CreatedAt,
  DataType,
  Default,
  DefaultScope,
  ForeignKey,
  HasMany,
  Is,
  Model,
  Scopes,
  Table,
  UpdatedAt
} from 'sequelize-typescript'
import validator from 'validator'
import { logger } from '@server/helpers/logger'
import { extractVideo } from '@server/helpers/video'
import { buildRemoteVideoBaseUrl } from '@server/lib/activitypub/url'
import {
  getHLSPrivateFileUrl,
  getHLSPublicFileUrl,
  getWebTorrentPrivateFileUrl,
  getWebTorrentPublicFileUrl
} from '@server/lib/object-storage'
import { getFSTorrentFilePath } from '@server/lib/paths'
import { isVideoInPrivateDirectory } from '@server/lib/video-privacy'
import { isStreamingPlaylist, MStreamingPlaylistVideo, MVideo, MVideoWithHost } from '@server/types/models'
import { VideoResolution, VideoStorage } from '@shared/models'
import { AttributesOnly } from '@shared/typescript-utils'
import {
  isVideoFileExtnameValid,
  isVideoFileInfoHashValid,
  isVideoFileResolutionValid,
  isVideoFileSizeValid,
  isVideoFPSResolutionValid
} from '../../helpers/custom-validators/videos'
import {
  LAZY_STATIC_PATHS,
  MEMOIZE_LENGTH,
  MEMOIZE_TTL,
  STATIC_DOWNLOAD_PATHS,
  STATIC_PATHS,
  WEBSERVER
} from '../../initializers/constants'
import { MVideoFile, MVideoFileStreamingPlaylistVideo, MVideoFileVideo } from '../../types/models/video/video-file'
import { VideoRedundancyModel } from '../redundancy/video-redundancy'
import { doesExist } from '../shared'
import { parseAggregateResult, throwIfNotValid } from '../utils'
import { VideoModel } from './video'
import { VideoStreamingPlaylistModel } from './video-streaming-playlist'

export enum ScopeNames {
  WITH_VIDEO = 'WITH_VIDEO',
  WITH_METADATA = 'WITH_METADATA',
  WITH_VIDEO_OR_PLAYLIST = 'WITH_VIDEO_OR_PLAYLIST'
}

@DefaultScope(() => ({
  attributes: {
    exclude: [ 'metadata' ]
  }
}))
@Scopes(() => ({
  [ScopeNames.WITH_VIDEO]: {
    include: [
      {
        model: VideoModel.unscoped(),
        required: true
      }
    ]
  },
  [ScopeNames.WITH_VIDEO_OR_PLAYLIST]: (options: { whereVideo?: WhereOptions } = {}) => {
    return {
      include: [
        {
          model: VideoModel.unscoped(),
          required: false,
          where: options.whereVideo
        },
        {
          model: VideoStreamingPlaylistModel.unscoped(),
          required: false,
          include: [
            {
              model: VideoModel.unscoped(),
              required: true,
              where: options.whereVideo
            }
          ]
        }
      ]
    }
  },
  [ScopeNames.WITH_METADATA]: {
    attributes: {
      include: [ 'metadata' ]
    }
  }
}))
@Table({
  tableName: 'videoFile',
  indexes: [
    {
      fields: [ 'videoId' ],
      where: {
        videoId: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'videoStreamingPlaylistId' ],
      where: {
        videoStreamingPlaylistId: {
          [Op.ne]: null
        }
      }
    },

    {
      fields: [ 'infoHash' ]
    },

    {
      fields: [ 'torrentFilename' ],
      unique: true
    },

    {
      fields: [ 'filename' ],
      unique: true
    },

    {
      fields: [ 'videoId', 'resolution', 'fps' ],
      unique: true,
      where: {
        videoId: {
          [Op.ne]: null
        }
      }
    },
    {
      fields: [ 'videoStreamingPlaylistId', 'resolution', 'fps' ],
      unique: true,
      where: {
        videoStreamingPlaylistId: {
          [Op.ne]: null
        }
      }
    }
  ]
})
export class VideoFileModel extends Model<Partial<AttributesOnly<VideoFileModel>>> {
  @CreatedAt
  createdAt: Date

  @UpdatedAt
  updatedAt: Date

  @AllowNull(false)
  @Is('VideoFileResolution', value => throwIfNotValid(value, isVideoFileResolutionValid, 'resolution'))
  @Column
  resolution: number

  @AllowNull(false)
  @Is('VideoFileSize', value => throwIfNotValid(value, isVideoFileSizeValid, 'size'))
  @Column(DataType.BIGINT)
  size: number

  @AllowNull(false)
  @Is('VideoFileExtname', value => throwIfNotValid(value, isVideoFileExtnameValid, 'extname'))
  @Column
  extname: string

  @AllowNull(true)
  @Is('VideoFileInfohash', value => throwIfNotValid(value, isVideoFileInfoHashValid, 'info hash', true))
  @Column
  infoHash: string

  @AllowNull(false)
  @Default(-1)
  @Is('VideoFileFPS', value => throwIfNotValid(value, isVideoFPSResolutionValid, 'fps'))
  @Column
  fps: number

  @AllowNull(true)
  @Column(DataType.JSONB)
  metadata: any

  @AllowNull(true)
  @Column
  metadataUrl: string

  // Could be null for remote files
  @AllowNull(true)
  @Column
  fileUrl: string

  // Could be null for live files
  @AllowNull(true)
  @Column
  filename: string

  // Could be null for remote files
  @AllowNull(true)
  @Column
  torrentUrl: string

  // Could be null for live files
  @AllowNull(true)
  @Column
  torrentFilename: string

  @ForeignKey(() => VideoModel)
  @Column
  videoId: number

  @AllowNull(false)
  @Default(VideoStorage.FILE_SYSTEM)
  @Column
  storage: VideoStorage

  @BelongsTo(() => VideoModel, {
    foreignKey: {
      allowNull: true
    },
    onDelete: 'CASCADE'
  })
  Video: VideoModel

  @ForeignKey(() => VideoStreamingPlaylistModel)
  @Column
  videoStreamingPlaylistId: number

  @BelongsTo(() => VideoStreamingPlaylistModel, {
    foreignKey: {
      allowNull: true
    },
    onDelete: 'CASCADE'
  })
  VideoStreamingPlaylist: VideoStreamingPlaylistModel

  @HasMany(() => VideoRedundancyModel, {
    foreignKey: {
      allowNull: true
    },
    onDelete: 'CASCADE',
    hooks: true
  })
  RedundancyVideos: VideoRedundancyModel[]

  static doesInfohashExistCached = memoizee(VideoFileModel.doesInfohashExist, {
    promise: true,
    max: MEMOIZE_LENGTH.INFO_HASH_EXISTS,
    maxAge: MEMOIZE_TTL.INFO_HASH_EXISTS
  })

  static doesInfohashExist (infoHash: string) {
    const query = 'SELECT 1 FROM "videoFile" WHERE "infoHash" = $infoHash LIMIT 1'

    return doesExist(query, { infoHash })
  }

  static async doesVideoExistForVideoFile (id: number, videoIdOrUUID: number | string) {
    const videoFile = await VideoFileModel.loadWithVideoOrPlaylist(id, videoIdOrUUID)

    return !!videoFile
  }

  static async doesOwnedTorrentFileExist (filename: string) {
    const query = 'SELECT 1 FROM "videoFile" ' +
                  'LEFT JOIN "video" "webtorrent" ON "webtorrent"."id" = "videoFile"."videoId" AND "webtorrent"."remote" IS FALSE ' +
                  'LEFT JOIN "videoStreamingPlaylist" ON "videoStreamingPlaylist"."id" = "videoFile"."videoStreamingPlaylistId" ' +
                  'LEFT JOIN "video" "hlsVideo" ON "hlsVideo"."id" = "videoStreamingPlaylist"."videoId" AND "hlsVideo"."remote" IS FALSE ' +
                  'WHERE "torrentFilename" = $filename AND ("hlsVideo"."id" IS NOT NULL OR "webtorrent"."id" IS NOT NULL) LIMIT 1'

    return doesExist(query, { filename })
  }

  static async doesOwnedWebTorrentVideoFileExist (filename: string) {
    const query = 'SELECT 1 FROM "videoFile" INNER JOIN "video" ON "video"."id" = "videoFile"."videoId" AND "video"."remote" IS FALSE ' +
                  `WHERE "filename" = $filename AND "storage" = ${VideoStorage.FILE_SYSTEM} LIMIT 1`

    return doesExist(query, { filename })
  }

  static loadByFilename (filename: string) {
    const query = {
      where: {
        filename
      }
    }

    return VideoFileModel.findOne(query)
  }

  static loadWithVideoByFilename (filename: string): Promise<MVideoFileVideo | MVideoFileStreamingPlaylistVideo> {
    const query = {
      where: {
        filename
      }
    }

    return VideoFileModel.scope(ScopeNames.WITH_VIDEO_OR_PLAYLIST).findOne(query)
  }

  static loadWithVideoOrPlaylistByTorrentFilename (filename: string) {
    const query = {
      where: {
        torrentFilename: filename
      }
    }

    return VideoFileModel.scope(ScopeNames.WITH_VIDEO_OR_PLAYLIST).findOne(query)
  }

  static load (id: number): Promise<MVideoFile> {
    return VideoFileModel.findByPk(id)
  }

  static loadWithMetadata (id: number) {
    return VideoFileModel.scope(ScopeNames.WITH_METADATA).findByPk(id)
  }

  static loadWithVideo (id: number) {
    return VideoFileModel.scope(ScopeNames.WITH_VIDEO).findByPk(id)
  }

  static loadWithVideoOrPlaylist (id: number, videoIdOrUUID: number | string) {
    const whereVideo = validator.isUUID(videoIdOrUUID + '')
      ? { uuid: videoIdOrUUID }
      : { id: videoIdOrUUID }

    const options = {
      where: {
        id
      }
    }

    return VideoFileModel.scope({ method: [ ScopeNames.WITH_VIDEO_OR_PLAYLIST, whereVideo ] })
      .findOne(options)
      .then(file => {
        // We used `required: false` so check we have at least a video or a streaming playlist
        if (!file.Video && !file.VideoStreamingPlaylist) return null

        return file
      })
  }

  static listByStreamingPlaylist (streamingPlaylistId: number, transaction: Transaction) {
    const query = {
      include: [
        {
          model: VideoModel.unscoped(),
          required: true,
          include: [
            {
              model: VideoStreamingPlaylistModel.unscoped(),
              required: true,
              where: {
                id: streamingPlaylistId
              }
            }
          ]
        }
      ],
      transaction
    }

    return VideoFileModel.findAll(query)
  }

  static getStats () {
    const webtorrentFilesQuery: FindOptions = {
      include: [
        {
          attributes: [],
          required: true,
          model: VideoModel.unscoped(),
          where: {
            remote: false
          }
        }
      ]
    }

    const hlsFilesQuery: FindOptions = {
      include: [
        {
          attributes: [],
          required: true,
          model: VideoStreamingPlaylistModel.unscoped(),
          include: [
            {
              attributes: [],
              model: VideoModel.unscoped(),
              required: true,
              where: {
                remote: false
              }
            }
          ]
        }
      ]
    }

    return Promise.all([
      VideoFileModel.aggregate('size', 'SUM', webtorrentFilesQuery),
      VideoFileModel.aggregate('size', 'SUM', hlsFilesQuery)
    ]).then(([ webtorrentResult, hlsResult ]) => ({
      totalLocalVideoFilesSize: parseAggregateResult(webtorrentResult) + parseAggregateResult(hlsResult)
    }))
  }

  // Redefine upsert because sequelize does not use an appropriate where clause in the update query with 2 unique indexes
  static async customUpsert (
    videoFile: MVideoFile,
    mode: 'streaming-playlist' | 'video',
    transaction: Transaction
  ) {
    const baseFind = {
      fps: videoFile.fps,
      resolution: videoFile.resolution,
      transaction
    }

    const element = mode === 'streaming-playlist'
      ? await VideoFileModel.loadHLSFile({ ...baseFind, playlistId: videoFile.videoStreamingPlaylistId })
      : await VideoFileModel.loadWebTorrentFile({ ...baseFind, videoId: videoFile.videoId })

    if (!element) return videoFile.save({ transaction })

    for (const k of Object.keys(videoFile.toJSON())) {
      element[k] = videoFile[k]
    }

    return element.save({ transaction })
  }

  static async loadWebTorrentFile (options: {
    videoId: number
    fps: number
    resolution: number
    transaction?: Transaction
  }) {
    const where = {
      fps: options.fps,
      resolution: options.resolution,
      videoId: options.videoId
    }

    return VideoFileModel.findOne({ where, transaction: options.transaction })
  }

  static async loadHLSFile (options: {
    playlistId: number
    fps: number
    resolution: number
    transaction?: Transaction
  }) {
    const where = {
      fps: options.fps,
      resolution: options.resolution,
      videoStreamingPlaylistId: options.playlistId
    }

    return VideoFileModel.findOne({ where, transaction: options.transaction })
  }

  static removeHLSFilesOfVideoId (videoStreamingPlaylistId: number) {
    const options = {
      where: { videoStreamingPlaylistId }
    }

    return VideoFileModel.destroy(options)
  }

  hasTorrent () {
    return this.infoHash && this.torrentFilename
  }

  getVideoOrStreamingPlaylist (this: MVideoFileVideo | MVideoFileStreamingPlaylistVideo): MVideo | MStreamingPlaylistVideo {
    if (this.videoId || (this as MVideoFileVideo).Video) return (this as MVideoFileVideo).Video

    return (this as MVideoFileStreamingPlaylistVideo).VideoStreamingPlaylist
  }

  getVideo (this: MVideoFileVideo | MVideoFileStreamingPlaylistVideo): MVideo {
    return extractVideo(this.getVideoOrStreamingPlaylist())
  }

  isAudio () {
    return this.resolution === VideoResolution.H_NOVIDEO
  }

  isLive () {
    return this.size === -1
  }

  isHLS () {
    return !!this.videoStreamingPlaylistId
  }

  // ---------------------------------------------------------------------------

  getObjectStorageUrl (video: MVideo) {
    if (video.hasPrivateStaticPath()) {
      return this.getPrivateObjectStorageUrl(video)
    }

    return this.getPublicObjectStorageUrl()
  }

  private getPrivateObjectStorageUrl (video: MVideo) {
    if (this.isHLS()) {
      return getHLSPrivateFileUrl(video, this.filename)
    }

    return getWebTorrentPrivateFileUrl(this.filename)
  }

  private getPublicObjectStorageUrl () {
    if (this.isHLS()) {
      return getHLSPublicFileUrl(this.fileUrl)
    }

    return getWebTorrentPublicFileUrl(this.fileUrl)
  }

  // ---------------------------------------------------------------------------

  getFileUrl (video: MVideo) {
    if (video.isOwned()) {
      if (this.storage === VideoStorage.OBJECT_STORAGE) {
        return this.getObjectStorageUrl(video)
      }

      return WEBSERVER.URL + this.getFileStaticPath(video)
    }

    return this.fileUrl
  }

  // ---------------------------------------------------------------------------

  getFileStaticPath (video: MVideo) {
    if (this.isHLS()) return this.getHLSFileStaticPath(video)

    return this.getWebTorrentFileStaticPath(video)
  }

  private getWebTorrentFileStaticPath (video: MVideo) {
    if (isVideoInPrivateDirectory(video.privacy)) {
      return join(STATIC_PATHS.PRIVATE_WEBSEED, this.filename)
    }

    return join(STATIC_PATHS.WEBSEED, this.filename)
  }

  private getHLSFileStaticPath (video: MVideo) {
    if (isVideoInPrivateDirectory(video.privacy)) {
      return join(STATIC_PATHS.STREAMING_PLAYLISTS.PRIVATE_HLS, video.uuid, this.filename)
    }

    return join(STATIC_PATHS.STREAMING_PLAYLISTS.HLS, video.uuid, this.filename)
  }

  // ---------------------------------------------------------------------------

  getFileDownloadUrl (video: MVideoWithHost) {
    const path = this.isHLS()
      ? join(STATIC_DOWNLOAD_PATHS.HLS_VIDEOS, `${video.uuid}-${this.resolution}-fragmented${this.extname}`)
      : join(STATIC_DOWNLOAD_PATHS.VIDEOS, `${video.uuid}-${this.resolution}${this.extname}`)

    if (video.isOwned()) return WEBSERVER.URL + path

    // FIXME: don't guess remote URL
    return buildRemoteVideoBaseUrl(video, path)
  }

  getRemoteTorrentUrl (video: MVideo) {
    if (video.isOwned()) throw new Error(`Video ${video.url} is not a remote video`)

    return this.torrentUrl
  }

  // We proxify torrent requests so use a local URL
  getTorrentUrl () {
    if (!this.torrentFilename) return null

    return WEBSERVER.URL + this.getTorrentStaticPath()
  }

  getTorrentStaticPath () {
    if (!this.torrentFilename) return null

    return join(LAZY_STATIC_PATHS.TORRENTS, this.torrentFilename)
  }

  getTorrentDownloadUrl () {
    if (!this.torrentFilename) return null

    return WEBSERVER.URL + join(STATIC_DOWNLOAD_PATHS.TORRENTS, this.torrentFilename)
  }

  removeTorrent () {
    if (!this.torrentFilename) return null

    const torrentPath = getFSTorrentFilePath(this)
    return remove(torrentPath)
      .catch(err => logger.warn('Cannot delete torrent %s.', torrentPath, { err }))
  }

  hasSameUniqueKeysThan (other: MVideoFile) {
    return this.fps === other.fps &&
      this.resolution === other.resolution &&
      (
        (this.videoId !== null && this.videoId === other.videoId) ||
        (this.videoStreamingPlaylistId !== null && this.videoStreamingPlaylistId === other.videoStreamingPlaylistId)
      )
  }

  withVideoOrPlaylist (videoOrPlaylist: MVideo | MStreamingPlaylistVideo) {
    if (isStreamingPlaylist(videoOrPlaylist)) return Object.assign(this, { VideoStreamingPlaylist: videoOrPlaylist })

    return Object.assign(this, { Video: videoOrPlaylist })
  }
}
