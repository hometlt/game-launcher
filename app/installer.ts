import {exec} from 'child_process';
import {YandexDiskWebDAV, GoogleDriveAPI, LocalFileClient, UpdateClientHeroku} from "./files";

export class Installer{
  map = `battlenet://starcraft/map/2/239053`

  strategy =  "PARALLEL"

  private fs= null
  private us= null
  private rs= null

  state = {
    downloading: false,
    initializing: true,
    ready: false,
    error: false,
    speed: 0,
    progress: 0,
    loaded: 0,
    size: 0,
    files: null,
    versions: null,
    version: "",
    gameDirectory: "",
    modDirectory: "",
    host: "",
  }
  fileServers = null;
  versions = null;
  updateCallback = null
  requests = []
  constructor({update}) {
    this.updateCallback = update


    this.fileServers = {
      google: GoogleDriveAPI,
      yandex: YandexDiskWebDAV
    }

    this.rs = new this.fileServers.google()
    this.fs = new LocalFileClient()
    this.us = new UpdateClientHeroku()
    this.us.infourl = this.rs.infourl
    this.initialize()
  }
  async initialize(){

    this.state.host = this.rs.host
    this.state.modDirectory = this.fs.modDirectory
    this.state.gameDirectory = this.fs.gameDirectory
    this.update()
    this.versions = await this.us.versions()
    this.state.versions = this.versions
    this.update()
    await this.check()
    this.state.initializing = false
    this.update()
  }

  update(){
    this.updateCallback(this.state)
  }
  get directory (){
    return this.fs.gameDirectory
  }
  async setDirectory(value){
    this.fs.setGameDirectory(value)
    this.state.initializing = true
    this.state.gameDirectory = value
    this.update()
    await this.check()
    this.state.initializing = false
    this.update()
  }
  get version(){
    return this.fs.version
  }
  async setVersion(value){
    this.fs.setCurrentVersion(value)
    this.state.initializing = true
    this.state.version = value
    await this.check()
    this.state.initializing = false
    this.update()
  }
  run (){
    //Windows
    exec(`rundll32 url.dll,FileProtocolHandler "${this.map}"`, function(err, data) {
      console.log(err)
      console.log(data.toString());
    });
  }

  async files(version){
    try{
      // @ts-ignore
      let installationInfo = await this.us.files()
      // @ts-ignore
      let versionFiles = installationInfo.filter(item => !item.path.startsWith("Versions"))
      if(version){
        // @ts-ignore
        versionFiles.push(...installationInfo.filter(item => item.path.startsWith("Versions/" + version.directory)))
      }
      return versionFiles
    }
    catch(e){
      console.log("error",e)
    }
  }
  _files= null
  async check() {
    // @ts-ignore
    let version = this.version && this.versions.find(v => v.id === this.version)
    this._files = await this.files(version)

    let size = 0;
    let ready = true;
    let error = false;
    let loaded = 0
    let files = []

    for(let file of this._files){
      let fileReady;
      let fileProgress;
      size += file.size
      let local = this.fs.directory + "/" + file.path;
      let localFileData = await this.fs.info(local)


      if(localFileData){
        loaded += localFileData.size
        fileReady = localFileData.modified >= file.modified && localFileData.size === file.size;
        if(fileReady){
          fileProgress = 100;
        }else {
          fileProgress = file.loaded / file.size * 100
          ready = false
        }
      }
      else{
        fileReady = false
        fileProgress = 0
        ready = false
      }

      files.push({
        local,
        id: file.id,
        name: file.path,
        // @ts-ignore
        loaded: localFileData.size || 0,
        size: file.size,
        ready: fileReady,
        progress: fileProgress
      })
    }

    Object.assign(this.state,{
      ready,
      error,
      loaded,
      size,
      files,
      initializing: false
    })

    return this.state
  }

  cancel(){
    for(let request of this.requests){
      request.destroy()
      this.state.downloading = false
      this.state.speed = 0;
      this.state.progress = this.state.loaded / this.state.size * 100
      this.state.ready = this.state.files.find(f => f.ready !== true) === null
      this.state.error = this.state.files.find(f => f.error !== true) !== null
      this.update()
    }
  }
  async install({onInstallBegin = null,onUploadingProgress = null,onUploadingComplete = null,onInstallComplete = null,onInstallError = null}) {
    this.state.initializing = true
    this.update()
    await this.check()
    this.state.downloading = true
    this.update()

    onInstallBegin?.(this.state)

    let interval = setInterval(() => {
      this.state.speed = 0;
      this.state.progress = this.state.loaded / this.state.size * 100
      this.state.files.forEach(file => {

        if(file.downloading){
          file.speed = file.recorded
          this.state.speed +=file.speed
          file.recorded = 0
        }
      })
      this.update()
    }, 1000)

    let promises = []
    let filesTotal = this.state.files.length
    for(let fileIndex = 0; fileIndex< filesTotal; fileIndex++ ){
      let fileData = this.state.files[fileIndex];
      if(!fileData.ready){
        let promise = new Promise(async (resolve , reject) => {
          let writeStream = this.fs.create(fileData.name)
          let readStream = await this.rs.stream(fileData)

          this.requests.push(readStream)

          Object.assign(fileData,{recorded: 0, loaded:  0, speed:  0, downloading:  true})

          onUploadingProgress?.(fileData)
          this.update()
          // @ts-ignore
          readStream.on('data', data => {
            writeStream.write(data, () => {
              if(!fileData.ready){
                fileData.loaded += data.length;
                this.state.loaded += data.length;
                fileData.progress = fileData.loaded / fileData.size * 100
                fileData.recorded +=data.length

                onUploadingProgress?.(fileData)
                this.update()
              }
            });
          })
          // @ts-ignore
          readStream.on('end', () => {
            resolve(fileData)
            this.requests.splice(this.requests.indexOf(readStream),1)
          })

        })
        .then(()=>{
          fileData.ready = true
          fileData.loaded = fileData.size
          fileData.progress = 100
          onUploadingComplete?.(fileData)
        })
        .catch((message)=>{
          fileData.error = true
          onInstallError?.(fileData)
        })
        .finally(()=>{
          delete fileData.recorded
          delete fileData.speed
          delete fileData.downloading
          this.update()
          return fileData
        })

        if(this.strategy === "QUEUE") {
          await promise
        }
        if(this.strategy === "PARALLEL") {
          promises.push(promise)
        }
      }
    }
    if(this.strategy === "PARALLEL") {
      await Promise.all(promises)
    }

    this.state.downloading = false
    this.state.speed = 0;
    this.state.progress = this.state.loaded / this.state.size * 100
    this.state.ready = this.state.files.find(f => f.ready !== true) === null
    this.state.error = this.state.files.find(f => f.error !== true) !== null

    clearInterval(interval)
    onInstallComplete?.()
    this.update()
  }
}
