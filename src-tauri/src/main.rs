#![cfg_attr(all(target_os = "windows", not(test)), windows_subsystem = "windows")]
use std::{collections::HashSet, fs, path::{Path, PathBuf}, sync::Mutex, time::Duration};
use tauri::{Manager, State};
use serde_json::{Value, json};
use fs2::FileExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

struct LibraryState { root: PathBuf, last: Option<String> }
struct AppState { library: Mutex<LibraryState>, client: reqwest::Client, downloads: tokio::sync::Semaphore }
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn read_optional(path: &Path) -> Result<Option<String>,String> { match fs::read_to_string(path) {Ok(s)=>Ok(Some(s)),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(err(e))} }
fn atomic_write(path:&Path, data:&[u8]) -> Result<(),String> {
    let temp=path.with_extension(format!("tmp-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos()));
    {use std::io::Write; let mut file=fs::File::create(&temp).map_err(err)?;file.write_all(data).map_err(err)?;file.sync_all().map_err(err)?;}
    // std::fs::rename replaces a file atomically on supported desktop platforms.
    fs::rename(&temp,path).map_err(err)
}
fn validate_library(data:&str)->Result<(),String> {let v:Value=serde_json::from_str(data).map_err(err)?;if v["version"]!=1||!v["conversations"].is_array()||!v["saved"].is_array(){return Err("资料库格式不兼容".into())} Ok(())}
#[tauri::command]
fn load_library(state:State<AppState>)->Result<Option<String>,String>{let mut s=state.library.lock().map_err(err)?;let data=read_optional(&s.root.join("library.json"))?;if let Some(ref d)=data{validate_library(d)?;}s.last=data.clone();Ok(data)}
#[tauri::command]
fn save_library(data:String,state:State<AppState>)->Result<(),String>{
    let mut s=state.library.lock().map_err(err)?;save_snapshot(&mut s,data)
}
fn save_snapshot(s:&mut LibraryState,data:String)->Result<(),String>{
    validate_library(&data)?;
    let lock=fs::OpenOptions::new().create(true).truncate(false).write(true).open(s.root.join(".write.lock")).map_err(err)?;
    lock.try_lock_exclusive().map_err(|_|"资料库正在被另一个进程写入，请稍后重试".to_string())?;
    let current=read_optional(&s.root.join("library.json"))?;
    if current!=s.last {return Err("检测到同步或其他窗口修改了资料库。为防止覆盖，已停止保存；请重启应用重新载入。".into())}
    if let Some(ref old)=current {atomic_write(&s.root.join("library.backup.json"),old.as_bytes())?;}
    atomic_write(&s.root.join("library.json"),data.as_bytes())?;s.last=Some(data);Ok(())
}
const IMAGE_DIRS: [&str; 5] = ["images", "cache/thumbnails", "cache/high-resolution", "cache/originals", "collection/originals"];
fn copy_tree(source:&Path,target:&Path)->Result<(),String>{
    if !source.is_dir(){return Ok(())}
    fs::create_dir_all(target).map_err(err)?;
    for entry in fs::read_dir(source).map_err(err)? {let entry=entry.map_err(err)?;let kind=entry.file_type().map_err(err)?;if kind.is_file(){fs::copy(entry.path(),target.join(entry.file_name())).map_err(err)?;}else if kind.is_dir(){copy_tree(&entry.path(),&target.join(entry.file_name()))?;}}
    Ok(())
}
fn copy_library(s:&LibraryState,target:&Path)->Result<(),String>{
    if fs::read_dir(target).map_err(err)?.next().is_some(){return Err("迁移目标必须为空文件夹；已有资料库请使用“打开已有资料库”".into())}
    if read_optional(&s.root.join("library.json"))? != s.last {return Err("资料库已被同步修改，请重启后再迁移".into())}
    for directory in IMAGE_DIRS {copy_tree(&s.root.join(directory),&target.join(directory))?;}
    if let Some(ref data)=s.last {atomic_write(&target.join("library.json"),data.as_bytes())?;}
    if let Some(backup)=read_optional(&s.root.join("library.backup.json"))? {atomic_write(&target.join("library.backup.json"),backup.as_bytes())?;}
    Ok(())
}
#[tauri::command]
fn library_directory(state:State<AppState>)->Result<String,String>{Ok(state.library.lock().map_err(err)?.root.to_string_lossy().into_owned())}
#[tauri::command]
async fn choose_directory()->Result<Option<String>,String>{Ok(rfd::AsyncFileDialog::new().set_title("选择拾色资料库文件夹").pick_folder().await.map(|p|p.path().to_string_lossy().into_owned()))}
#[tauri::command]
async fn switch_library(path:String,mode:String,app:tauri::AppHandle,state:State<'_,AppState>)->Result<(),String>{
    // Drain queued downloads before copying; newly queued downloads use the new root.
    let _downloads=state.downloads.acquire_many(3).await.map_err(err)?;
    let target=PathBuf::from(path);if !target.is_absolute()||!target.is_dir(){return Err("请选择已存在的文件夹".into())}
    let target=target.canonicalize().map_err(err)?;
    let mut s=state.library.lock().map_err(err)?;let old=s.root.canonicalize().map_err(err)?;
    if target==old{return Ok(())}
    if target.starts_with(&old)||old.starts_with(&target){return Err("新资料库不能是当前资料库的父目录或子目录".into())}
    if mode=="copy" {
        copy_library(&s,&target)?;
    } else if mode=="open" {let data=fs::read_to_string(target.join("library.json")).map_err(|_|"所选文件夹中没有 library.json".to_string())?;validate_library(&data)?;} else {return Err("无效操作".into())}
    for directory in IMAGE_DIRS {fs::create_dir_all(target.join(directory)).map_err(err)?;}
    let config=app.path().app_config_dir().map_err(err)?;fs::create_dir_all(&config).map_err(err)?;
    atomic_write(&config.join("location.json"),serde_json::to_string(&target).map_err(err)?.as_bytes())?;
    for directory in IMAGE_DIRS {app.asset_protocol_scope().allow_directory(target.join(directory),true).map_err(err)?;}
    s.root=target;s.last=read_optional(&s.root.join("library.json"))?;Ok(())
}
fn image_url(url:&str)->Result<reqwest::Url,String>{let u=reqwest::Url::parse(url).map_err(err)?;if u.scheme()!="https"||!matches!(u.host_str(),Some("upload.wikimedia.org"|"thumb.wikimedia.org"))||!u.username().is_empty()||u.password().is_some(){return Err("只允许 Wikimedia 图片地址".into())}Ok(u)}
#[tauri::command]
async fn commons_query(query:String,state:State<'_,AppState>)->Result<Value,String>{
    let mut url=reqwest::Url::parse("https://commons.wikimedia.org/w/api.php").unwrap();url.set_query(Some(&query));
    if url.query_pairs().any(|(k,v)|k=="action"&&v!="query"){return Err("仅允许查询接口".into())}
    state.client.get(url).send().await.map_err(err)?.error_for_status().map_err(err)?.json().await.map_err(err)
}
#[tauri::command]
async fn cache_image(id:u64,url:String,variant:String,state:State<'_,AppState>)->Result<String,String>{
    let validated=image_url(&url)?;
    let (directory,suffix)=match variant.as_str(){"preview"=>("cache/thumbnails",""),"hd"=>("cache/high-resolution","-hd"),"original"=>("cache/originals","-original"),"collection"=>("collection/originals","-original"),_=>return Err("无效图片版本".into())};
    let _permit=state.downloads.acquire().await.map_err(err)?;
    let root=state.library.lock().map_err(err)?.root.clone();
    let name=format!("{id}");
    for ext in ["jpg","png","webp"] {let relative=format!("{directory}/{name}.{ext}");if root.join(&relative).is_file(){return Ok(relative)}}
    // Reuse a downloaded original without touching the legacy file that an old saved entry may still reference.
    if variant=="collection" {
        for (source_dir,source_name) in [("cache/originals",format!("{id}")), ("images",format!("{id}-original"))] {for ext in ["jpg","png","webp"] {
            let source=root.join(format!("{source_dir}/{source_name}.{ext}"));
            if source.is_file(){let relative=format!("{directory}/{id}.{ext}");fs::create_dir_all(root.join(directory)).map_err(err)?;fs::copy(source,root.join(&relative)).map_err(err)?;return Ok(relative)}
        }}
    }
    if variant!="collection" {for ext in ["jpg","png","webp"] {
        let source=root.join(format!("images/{id}{suffix}.{ext}"));
        if source.is_file(){let relative=format!("{directory}/{id}.{ext}");fs::create_dir_all(root.join(directory)).map_err(err)?;fs::copy(source,root.join(&relative)).map_err(err)?;return Ok(relative)}
    }}
    let mut response=state.client.get(validated).timeout(Duration::from_secs(if variant=="original"||variant=="collection"{300}else{45})).send().await.map_err(err)?.error_for_status().map_err(err)?;
    let ext=match response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or(""){"image/jpeg"=>"jpg","image/png"=>"png","image/webp"=>"webp",_=>return Err("不支持的图片类型".into())};
    fs::create_dir_all(root.join(directory)).map_err(err)?;let relative=format!("{directory}/{name}.{ext}");
    let limit=if variant=="original"||variant=="collection"{512_u64*1024*1024}else{32_u64*1024*1024};
    if response.content_length().unwrap_or(0)>limit{return Err("图片超过下载大小限制，请从 Wikimedia 来源页查看".into())}
    let temporary=root.join(directory).join(format!(".{name}-{}-{}.partial",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos()));
    let result:Result<String,String>=async {
        let mut file=tokio::fs::File::create(&temporary).await.map_err(err)?;
        let mut received=0_u64;
        while let Some(chunk)=response.chunk().await.map_err(err)?{
            received+=chunk.len() as u64;
            if received>limit{return Err("图片超过下载大小限制，请从 Wikimedia 来源页查看".into())}
            file.write_all(&chunk).await.map_err(err)?;
        }
        file.sync_all().await.map_err(err)?;
        drop(file);
        tokio::fs::rename(&temporary,root.join(&relative)).await.map_err(err)?;
        Ok(relative)
    }.await;
    if result.is_err(){let _=tokio::fs::remove_file(&temporary).await;}
    result
}
#[tauri::command]
fn image_path(relative:String,state:State<AppState>)->Result<String,String>{
    let s=state.library.lock().map_err(err)?;let p=s.root.join(&relative).canonicalize().map_err(err)?;
    let permitted=IMAGE_DIRS.iter().any(|directory|s.root.join(directory).canonicalize().is_ok_and(|base|p.starts_with(base)));
    if !permitted||!p.is_file(){return Err("无效的本地图片路径".into())}Ok(webview_path(&p))
}
fn webview_path(path:&std::path::Path)->String{
    let full=path.to_string_lossy();
    if let Some(unc)=full.strip_prefix(r"\\?\UNC\"){format!("\\\\{unc}")}
    else if let Some(normal)=full.strip_prefix(r"\\?\"){normal.to_owned()}
    else{full.into_owned()}
}
fn clear_unreferenced(root:&Path,directory:&str,keep:&HashSet<String>)->Result<(u64,u64),String>{
    let base=root.join(directory);if !base.is_dir(){return Ok((0,0))}
    let mut count=0;let mut bytes=0;
    for entry in fs::read_dir(&base).map_err(err)?{let entry=entry.map_err(err)?;if !entry.file_type().map_err(err)?.is_file(){continue}
        let relative=format!("{directory}/{}",entry.file_name().to_string_lossy());
        if keep.contains(&relative){continue}
        bytes+=entry.metadata().map_err(err)?.len();fs::remove_file(entry.path()).map_err(err)?;count+=1;
    }
    Ok((count,bytes))
}
#[tauri::command]
async fn clear_image_cache(state:State<'_,AppState>)->Result<Value,String>{
    let _downloads=state.downloads.acquire_many(3).await.map_err(err)?;
    let s=state.library.lock().map_err(err)?;
    let (files,bytes)=clear_cache_files(&s)?;
    Ok(json!({"files":files,"bytes":bytes}))
}
fn clear_cache_files(s:&LibraryState)->Result<(u64,u64),String>{
    let current=read_optional(&s.root.join("library.json"))?;
    if current!=s.last{return Err("资料库已被同步修改，请重启后再清理缓存".into())}
    let mut keep=HashSet::new();
    for document in [current,read_optional(&s.root.join("library.backup.json"))?].into_iter().flatten(){
        let saved:Value=serde_json::from_str(&document).map_err(err)?;
        keep.extend(saved["saved"].as_array().into_iter().flatten().filter_map(|item|item["local"].as_str().map(str::to_string)));
    }
    let mut files=0;let mut bytes=0;
    for directory in ["cache/thumbnails","cache/high-resolution","cache/originals","images"] {
        let (count,size)=clear_unreferenced(&s.root,directory,&keep)?;files+=count;bytes+=size;
    }
    Ok((files,bytes))
}
fn endpoint(base:&str)->Result<reqwest::Url,String>{
    let url=reqwest::Url::parse(base.trim_end_matches('/')).map_err(err)?;
    let local=matches!(url.host_str(),Some("localhost"|"127.0.0.1"|"[::1]"));
    if !(url.scheme()=="https" || url.scheme()=="http"&&local)||url.host_str().is_none()||!url.username().is_empty()||url.password().is_some()||url.query().is_some()||url.fragment().is_some(){return Err("API 地址需为 HTTPS（本地服务可使用 HTTP），不能含账号、查询参数或片段".into())}
    Ok(url)
}
fn credential(base:&str)->Result<keyring::Entry,String>{let url=endpoint(base)?;keyring::Entry::new("art.atelier.gallery",url.as_str()).map_err(err)}
#[tauri::command]
fn save_api_key(base_url:String,key:String)->Result<(),String>{let e=credential(&base_url)?;if key.is_empty(){match e.delete_credential(){Ok(())|Err(keyring::Error::NoEntry)=>Ok(()),Err(e)=>Err(err(e))}}else{e.set_password(&key).map_err(err)}}
#[tauri::command]
fn has_api_key(base_url:String)->Result<bool,String>{match credential(&base_url)?.get_password(){Ok(_)=>Ok(true),Err(keyring::Error::NoEntry)=>Ok(false),Err(e)=>Err(err(e))}}
#[tauri::command]
fn open_external(url:String,app:tauri::AppHandle)->Result<(),String>{let parsed=reqwest::Url::parse(&url).map_err(err)?;if parsed.scheme()!="https"||!parsed.username().is_empty()||parsed.password().is_some(){return Err("只允许打开 HTTPS 来源链接".into())}app.opener().open_url(url,None::<&str>).map_err(err)}
#[tauri::command]
async fn ai_plan(base_url:String,model:String,key:String,messages:Value,state:State<'_,AppState>)->Result<String,String>{
    let base=endpoint(&base_url)?;let url=format!("{}/chat/completions",base.as_str().trim_end_matches('/'));
    let secret=if key.is_empty(){credential(&base_url)?.get_password().unwrap_or_default()}else{key};
    let mut request=state.client.post(url).json(&json!({"model":model,"messages":messages,"temperature":0.5,"max_tokens":900}));
    if !secret.is_empty(){request=request.bearer_auth(secret);}
    let response=request.send().await.map_err(|_|"无法连接 AI 服务，请检查地址和网络".to_string())?;
    let status=response.status();if !status.is_success(){return Err(format!("AI 服务返回 {status}，请检查密钥、模型和额度"))}
    let value:Value=response.json().await.map_err(err)?;value["choices"][0]["message"]["content"].as_str().map(str::to_string).ok_or_else(||"AI 响应格式不兼容".into())
}
fn main(){tauri::Builder::default().plugin(tauri_plugin_opener::init()).setup(|app|{
    let config=app.path().app_config_dir()?;let pointer=config.join("location.json");
    let root:PathBuf=if pointer.exists(){let root:PathBuf=serde_json::from_str(&fs::read_to_string(pointer)?)?;if !root.is_dir(){return Err(format!("资料库目录不可用，请等待同步或恢复该目录：{}",root.display()).into())}root}else{app.path().app_data_dir()?.join("Library")};
    for directory in IMAGE_DIRS {fs::create_dir_all(root.join(directory))?;app.asset_protocol_scope().allow_directory(root.join(directory),true)?;}
    let client=reqwest::Client::builder().user_agent("AtelierGallery/0.1 (personal open-art desktop viewer)").timeout(Duration::from_secs(45)).redirect(reqwest::redirect::Policy::none()).build()?;
    app.manage(AppState{library:Mutex::new(LibraryState{root,last:None}),client,downloads:tokio::sync::Semaphore::new(3)});Ok(())
}).invoke_handler(tauri::generate_handler![load_library,save_library,library_directory,choose_directory,switch_library,commons_query,cache_image,image_path,clear_image_cache,save_api_key,has_api_key,ai_plan,open_external]).run(tauri::generate_context!()).expect("启动拾色失败");}

#[cfg(test)]
mod tests {use super::*;
    #[test]fn native_asset_path_omits_windows_device_prefix(){assert_eq!(webview_path(std::path::Path::new(r"\\?\D:\Gallery\images\1.jpg")),r"D:\Gallery\images\1.jpg");assert_eq!(webview_path(std::path::Path::new(r"\\?\UNC\server\Gallery\1.jpg")),r"\\server\Gallery\1.jpg");}
    #[test]fn reject_untrusted_images(){assert!(image_url("https://upload.wikimedia.org/a.jpg").is_ok());assert!(image_url("https://upload.wikimedia.org.evil.test/a").is_err());assert!(image_url("file:///etc/passwd").is_err());}
    #[test]fn endpoint_security(){assert!(endpoint("https://example.com/v1").is_ok());assert!(endpoint("http://127.0.0.1:11434/v1").is_ok());assert!(endpoint("http://example.com/v1").is_err());assert!(endpoint("https://user:secret@example.com").is_err());}
    fn fixture()->LibraryState {let root=std::env::temp_dir().join(format!("atelier-test-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));fs::create_dir_all(root.join("images")).unwrap();LibraryState{root,last:None}}
    fn data(label:&str)->String{json!({"version":1,"conversations":[],"saved":[],"label":label}).to_string()}
    #[test]fn backup_and_conflict_protection(){let mut s=fixture();save_snapshot(&mut s,data("first")).unwrap();save_snapshot(&mut s,data("second")).unwrap();assert_eq!(fs::read_to_string(s.root.join("library.backup.json")).unwrap(),data("first"));fs::write(s.root.join("library.json"),data("remote")).unwrap();assert!(save_snapshot(&mut s,data("local")).is_err());assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),data("remote"));fs::remove_dir_all(s.root).unwrap();}
    #[test]fn migration_copies_images_and_keeps_source(){let mut s=fixture();let t=fixture();fs::remove_dir(t.root.join("images")).unwrap();save_snapshot(&mut s,data("collection")).unwrap();fs::write(s.root.join("images/1.jpg"),b"image fixture").unwrap();copy_library(&s,&t.root).unwrap();assert_eq!(fs::read(t.root.join("images/1.jpg")).unwrap(),b"image fixture");assert!(s.root.join("library.json").exists());assert!(copy_library(&s,&t.root).is_err());fs::remove_dir_all(s.root).unwrap();fs::remove_dir_all(t.root).unwrap();}
    #[test]fn malformed_data_does_not_replace_library(){let mut s=fixture();save_snapshot(&mut s,data("good")).unwrap();assert!(save_snapshot(&mut s,"{}".into()).is_err());assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),data("good"));fs::remove_dir_all(s.root).unwrap();}
    #[test]fn clear_cache_preserves_collection_and_legacy_saved_images(){
        let mut s=fixture();
        save_snapshot(&mut s,json!({"version":1,"conversations":[],"saved":[{"local":"images/7-original.jpg"},{"local":"cache/high-resolution/8.jpg"}]}).to_string()).unwrap();
        fs::write(s.root.join("library.backup.json"),json!({"saved":[{"local":"images/6-original.jpg"}]}).to_string()).unwrap();
        for (directory,name) in [("images","7-original.jpg"),("images","6-original.jpg"),("images","9.jpg"),("cache/thumbnails","9.jpg"),("cache/high-resolution","8.jpg"),("cache/originals","9.jpg"),("collection/originals","10.jpg")] {
            let folder=s.root.join(directory);fs::create_dir_all(&folder).unwrap();fs::write(folder.join(name),b"art").unwrap();
        }
        let (files,bytes)=clear_cache_files(&s).unwrap();
        assert_eq!((files,bytes),(3,9));
        assert!(s.root.join("images/7-original.jpg").exists());
        assert!(s.root.join("images/6-original.jpg").exists());
        assert!(s.root.join("cache/high-resolution/8.jpg").exists());
        assert!(s.root.join("collection/originals/10.jpg").exists());
        assert!(!s.root.join("cache/originals/9.jpg").exists());
        fs::remove_dir_all(s.root).unwrap();
    }
    #[test]fn migration_copies_separated_images(){
        let mut s=fixture();let target=fixture();fs::remove_dir(target.root.join("images")).unwrap();
        save_snapshot(&mut s,data("separated")).unwrap();
        fs::write(s.root.join("library.backup.json"),data("backup")).unwrap();
        for directory in ["cache/thumbnails","cache/high-resolution","cache/originals","collection/originals"] {
            fs::create_dir_all(s.root.join(directory)).unwrap();fs::write(s.root.join(directory).join("1.jpg"),directory.as_bytes()).unwrap();
        }
        copy_library(&s,&target.root).unwrap();
        for directory in ["cache/thumbnails","cache/high-resolution","cache/originals","collection/originals"] {
            assert_eq!(fs::read(target.root.join(directory).join("1.jpg")).unwrap(),directory.as_bytes());
        }
        assert_eq!(fs::read_to_string(target.root.join("library.backup.json")).unwrap(),data("backup"));
        fs::remove_dir_all(s.root).unwrap();fs::remove_dir_all(target.root).unwrap();
    }
}
