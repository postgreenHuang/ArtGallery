#![cfg_attr(all(target_os = "windows", not(test)), windows_subsystem = "windows")]
use std::{collections::{BTreeMap, HashMap, HashSet}, fs, path::{Path, PathBuf}, sync::Mutex, time::{Duration, Instant}};
use tauri::{Emitter, Manager, State};
use serde_json::{Value, json};
use fs2::FileExt;
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

struct LibraryState { root: PathBuf, last: Option<String> }
struct AppState { library: Mutex<LibraryState>, brave_usage_lock: Mutex<()>, client: reqwest::Client, downloads: tokio::sync::Semaphore, chicago_downloads: tokio::sync::Semaphore, original_cooldown: Mutex<Option<Instant>>, query_cooldown: Mutex<Option<Instant>>, image_cooldown: Mutex<Option<Instant>>, museum_cooldowns: Mutex<HashMap<String,Instant>>, query_pacing: tokio::sync::Mutex<Instant>, museum_pacing: tokio::sync::Mutex<Instant>, chicago_image_pacing: tokio::sync::Mutex<Instant> }
#[derive(Default, serde::Serialize, serde::Deserialize, Clone)]
struct BraveMonth { web: u64, images: u64 }
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct BraveUsage { months: BTreeMap<String, BraveMonth> }
#[derive(serde::Serialize)]
struct BraveUsageSummary { month: String, web: u64, images: u64, history: BTreeMap<String, BraveMonth> }
fn brave_month() -> String { chrono::Local::now().format("%Y-%m").to_string() }
fn read_brave_usage(root: &Path) -> Result<BraveUsage,String> {
    read_optional(&root.join("brave-usage.json"))?.map(|data|serde_json::from_str(&data).map_err(err)).unwrap_or_else(||Ok(BraveUsage::default()))
}
fn brave_usage_summary(root: &Path) -> Result<BraveUsageSummary,String> {
    let history=read_brave_usage(root)?.months;
    let month=brave_month();
    let current=history.get(&month).cloned().unwrap_or_default();
    Ok(BraveUsageSummary{month,web:current.web,images:current.images,history})
}
fn count_brave_request(state:&AppState,kind:&str)->Result<(),String>{
    let root=state.library.lock().map_err(err)?.root.clone();
    let _guard=state.brave_usage_lock.lock().map_err(err)?;
    let lock=fs::OpenOptions::new().create(true).truncate(false).write(true).open(root.join(".brave-usage.lock")).map_err(err)?;
    lock.lock_exclusive().map_err(err)?;
    let mut usage=read_brave_usage(&root)?;
    let month=usage.months.entry(brave_month()).or_default();
    match kind {"web"=>month.web=month.web.saturating_add(1),"images"=>month.images=month.images.saturating_add(1),_=>return Err("未知 Brave 请求类型".into())}
    atomic_write(&root.join("brave-usage.json"),serde_json::to_string_pretty(&usage).map_err(err)?.as_bytes())
}
#[tauri::command]
fn brave_usage(state:State<AppState>)->Result<BraveUsageSummary,String>{
    let root=state.library.lock().map_err(err)?.root.clone();
    let _guard=state.brave_usage_lock.lock().map_err(err)?;
    brave_usage_summary(&root)
}
fn err(e: impl std::fmt::Display) -> String { e.to_string() }
fn check_cooldown(until:&Mutex<Option<Instant>>,label:&str)->Result<(),String>{
    let deadline=until.lock().map_err(err)?;
    if let Some(remaining)=deadline.and_then(|value|value.checked_duration_since(Instant::now())){
        return Err(format!("Wikimedia {label}暂时受限（HTTP 429），请约 {} 分钟后再试。",remaining.as_secs().div_ceil(60).max(1)))
    }
    Ok(())
}
fn note_cooldown(until:&Mutex<Option<Instant>>,response:&reqwest::Response,label:&str)->String{
    let seconds=response.headers().get(reqwest::header::RETRY_AFTER).and_then(|header|header.to_str().ok()).and_then(|value|value.parse::<u64>().ok()).unwrap_or(300).clamp(1,3600);
    if let Ok(mut deadline)=until.lock(){*deadline=Some(Instant::now()+Duration::from_secs(seconds));}
    format!("Wikimedia {label}暂时受限（HTTP 429），请约 {} 分钟后再试。",seconds.div_ceil(60))
}
fn check_original_cooldown(state:&AppState)->Result<(),String>{
    let until=state.original_cooldown.lock().map_err(err)?;
    if let Some(remaining)=until.and_then(|deadline|deadline.checked_duration_since(Instant::now())) {
        return Err(format!("Wikimedia 暂时限制请求，请约 {} 分钟后再试；已下载的本地作品仍可查看。",remaining.as_secs().div_ceil(60).max(1)))
    }
    Ok(())
}
fn note_original_rate_limit(state:&AppState,response:&reqwest::Response)->String{
    let seconds=response.headers().get(reqwest::header::RETRY_AFTER).and_then(|header|header.to_str().ok()).and_then(|value|value.parse::<u64>().ok()).unwrap_or(300).clamp(60,3600);
    if let Ok(mut until)=state.original_cooldown.lock(){*until=Some(Instant::now()+Duration::from_secs(seconds));}
    format!("Wikimedia 暂时限制下载（HTTP 429）。请约 {} 分钟后重试；原图未下载成功，已保存的本地作品不受影响。",seconds.div_ceil(60))
}
fn read_optional(path: &Path) -> Result<Option<String>,String> { match fs::read_to_string(path) {Ok(s)=>Ok(Some(s)),Err(e) if e.kind()==std::io::ErrorKind::NotFound=>Ok(None),Err(e)=>Err(err(e))} }
fn atomic_write(path:&Path, data:&[u8]) -> Result<(),String> {
    let temp=path.with_extension(format!("tmp-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos()));
    {use std::io::Write; let mut file=fs::File::create(&temp).map_err(err)?;file.write_all(data).map_err(err)?;file.sync_all().map_err(err)?;}
    // std::fs::rename replaces a file atomically on supported desktop platforms.
    fs::rename(&temp,path).map_err(err)
}
fn validate_library(data:&str)->Result<(),String> {let v:Value=serde_json::from_str(data).map_err(err)?;if v["version"]!=1||!v["conversations"].is_array()||!v["saved"].is_array(){return Err("资料库格式不兼容".into())} Ok(())}
#[tauri::command]
fn load_library(state:State<AppState>)->Result<Option<String>,String>{let mut s=state.library.lock().map_err(err)?;let data=read_optional(&s.root.join("library.json"))?;s.last=data.clone();if let Some(ref d)=data{validate_library(d)?;}Ok(data)}
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
    if current.as_deref().is_some_and(|old|validate_library(old).is_err()) {return Err("资料库格式不兼容，不能直接覆盖；请先从备份恢复".into())}
    if let Some(ref old)=current {atomic_write(&s.root.join("library.backup.json"),old.as_bytes())?;}
    atomic_write(&s.root.join("library.json"),data.as_bytes())?;s.last=Some(data);Ok(())
}
#[derive(serde::Serialize)]
struct BackupSummary { saved: usize, conversations: usize }
fn read_backup_summary(root:&Path)->Result<Option<BackupSummary>,String>{
    let Some(data)=read_optional(&root.join("library.backup.json"))? else {return Ok(None)};
    validate_library(&data)?;
    let value:Value=serde_json::from_str(&data).map_err(err)?;
    Ok(Some(BackupSummary{saved:value["saved"].as_array().map_or(0,Vec::len),conversations:value["conversations"].as_array().map_or(0,Vec::len)}))
}
#[tauri::command]
fn library_backup_summary(state:State<AppState>)->Result<Option<BackupSummary>,String>{
    let s=state.library.lock().map_err(err)?;read_backup_summary(&s.root)
}
fn restore_backup_snapshot(s:&mut LibraryState)->Result<String,String>{
    let lock=fs::OpenOptions::new().create(true).truncate(false).write(true).open(s.root.join(".write.lock")).map_err(err)?;
    lock.try_lock_exclusive().map_err(|_|"资料库正在被另一个进程写入，请稍后重试".to_string())?;
    let backup=read_optional(&s.root.join("library.backup.json"))?.ok_or("没有可用的资料库备份")?;
    validate_library(&backup)?;
    let current=read_optional(&s.root.join("library.json"))?;
    if current!=s.last {return Err("资料库在恢复前已被其他程序修改，请重新启动后再试".into())}
    if current.as_deref().is_some_and(|data|validate_library(data).is_ok()){
        return Err("当前资料库仍可读取；为避免覆盖，不能使用损坏资料库恢复功能".into())
    }
    let archived=if let Some(ref data)=current {
        let name=format!("library.corrupt-{}-{}.json",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos());
        let path=s.root.join(name);
        {use std::io::Write;let mut file=fs::OpenOptions::new().create_new(true).write(true).open(&path).map_err(err)?;file.write_all(data.as_bytes()).map_err(err)?;file.sync_all().map_err(err)?;}
        Some(path)
    }else{None};
    atomic_write(&s.root.join("library.json"),backup.as_bytes())?;
    s.last=Some(backup);
    Ok(archived.map(|path|path.to_string_lossy().into_owned()).unwrap_or_default())
}
#[tauri::command]
fn restore_library_backup(state:State<AppState>)->Result<String,String>{
    let mut s=state.library.lock().map_err(err)?;restore_backup_snapshot(&mut s)
}
const IMAGE_DIRS: [&str; 6] = ["images", "cache/thumbnails", "cache/medium-resolution", "cache/high-resolution", "cache/originals", "collection/originals"];
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
    if let Some(usage)=read_optional(&s.root.join("brave-usage.json"))? {atomic_write(&target.join("brave-usage.json"),usage.as_bytes())?;}
    copy_tree(&s.root.join("wallpapers"),&target.join("wallpapers"))?;
    Ok(())
}
#[tauri::command]
fn library_directory(state:State<AppState>)->Result<String,String>{Ok(state.library.lock().map_err(err)?.root.to_string_lossy().into_owned())}
#[tauri::command]
async fn choose_directory()->Result<Option<String>,String>{Ok(rfd::AsyncFileDialog::new().set_title("选择拾色资料库文件夹").pick_folder().await.map(|p|p.path().to_string_lossy().into_owned()))}
#[tauri::command]
async fn switch_library(path:String,mode:String,app:tauri::AppHandle,state:State<'_,AppState>)->Result<(),String>{
    // Drain queued downloads before copying; newly queued downloads use the new root.
    let _downloads=state.downloads.acquire_many(2).await.map_err(err)?;
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
fn image_url(url:&str)->Result<reqwest::Url,String>{
    let mut u=reqwest::Url::parse(url).map_err(err)?;
    let host=u.host_str().unwrap_or("");
    let path=u.path();
    let wikimedia=matches!(host,"upload.wikimedia.org"|"thumb.wikimedia.org");
    let trusted=match host{
        "upload.wikimedia.org"|"thumb.wikimedia.org"=>true,
        "openaccess-cdn.clevelandart.org"=>path.ends_with("_web.jpg")||path.ends_with("_print.jpg"),
        "images.metmuseum.org"=>path.starts_with("/CRDImages/")&&(path.to_ascii_lowercase().ends_with(".jpg")||path.to_ascii_lowercase().ends_with(".jpeg")),
        "www.artic.edu"=>path.starts_with("/iiif/2/")&&path.ends_with("/0/default.jpg"),
        _=>false,
    };
    if u.scheme()!="https"||!trusted||u.port().is_some()||!u.username().is_empty()||u.password().is_some()||(!wikimedia&&u.query().is_some())||u.fragment().is_some(){
        return Err("只允许已核准馆藏的 HTTPS 图片地址".into())
    }
    // Commons imageinfo adds attribution/tracking query parameters to static CDN URLs.
    // Never forward those parameters; fetch the same trusted image path directly.
    if wikimedia {u.set_query(None);}
    Ok(u)
}
fn museum_cooldown(state:&AppState,provider:&str)->Result<(),String>{let limits=state.museum_cooldowns.lock().map_err(err)?;if let Some(remaining)=limits.get(provider).and_then(|until|until.checked_duration_since(Instant::now())){return Err(format!("{provider} 暂时受限（HTTP 429），请约 {} 分钟后再试。",remaining.as_secs().div_ceil(60).max(1)))}Ok(())}
fn note_museum_cooldown(state:&AppState,provider:&str,response:&reqwest::Response)->String{let seconds=response.headers().get(reqwest::header::RETRY_AFTER).and_then(|header|header.to_str().ok()).and_then(|value|value.parse::<u64>().ok()).unwrap_or(300).clamp(60,3600);if let Ok(mut limits)=state.museum_cooldowns.lock(){limits.insert(provider.to_string(),Instant::now()+Duration::from_secs(seconds));}format!("{provider} 暂时受限（HTTP 429），请约 {} 分钟后再试。",seconds.div_ceil(60))}
#[tauri::command]
fn cached_image(id:u64,variant:String,state:State<AppState>)->Result<Option<String>,String>{
    let directory=match variant.as_str(){"preview"=>"cache/thumbnails","medium"=>"cache/medium-resolution","hd"=>"cache/high-resolution","original"=>"cache/originals",_=>return Err("无效图片版本".into())};
    let root=state.library.lock().map_err(err)?.root.clone();
    for ext in ["jpg","png","webp"]{let relative=format!("{directory}/{id}.{ext}");if root.join(&relative).is_file(){return Ok(Some(relative))}}
    Ok(None)
}
#[tauri::command]
async fn commons_query(query:String,state:State<'_,AppState>)->Result<Value,String>{
    let mut url=reqwest::Url::parse("https://commons.wikimedia.org/w/api.php").unwrap();url.set_query(Some(&query));
    if url.query_pairs().any(|(k,v)|k=="action"&&v!="query"){return Err("仅允许查询接口".into())}
    check_cooldown(&state.query_cooldown,"查询")?;
    {
        let mut next=state.query_pacing.lock().await;
        if let Some(wait)=next.checked_duration_since(Instant::now()){tokio::time::sleep(wait).await;}
        check_cooldown(&state.query_cooldown,"查询")?;
        *next=Instant::now()+Duration::from_millis(750);
    }
    let response=state.client.get(url).send().await.map_err(err)?;
    if response.status()==reqwest::StatusCode::TOO_MANY_REQUESTS{return Err(note_cooldown(&state.query_cooldown,&response,"查询"))}
    response.error_for_status().map_err(err)?.json().await.map_err(err)
}
#[tauri::command]
async fn museum_query(provider:String,query:String,state:State<'_,AppState>)->Result<Value,String>{
    if query.len()>2048{return Err("馆藏查询过长".into())}
    let base=match provider.as_str(){"cleveland"=>"https://openaccess-api.clevelandart.org/api/artworks/","chicago"=>"https://api.artic.edu/api/v1/artworks/search",_=>return Err("未知馆藏来源".into())};
    let mut url=reqwest::Url::parse(base).map_err(err)?;url.set_query(Some(&query));
    museum_cooldown(&state,&provider)?;
    {let mut next=state.museum_pacing.lock().await;if let Some(wait)=next.checked_duration_since(Instant::now()){tokio::time::sleep(wait).await;}museum_cooldown(&state,&provider)?;*next=Instant::now()+Duration::from_millis(400);}
    let response=state.client.get(url).timeout(Duration::from_secs(30)).send().await.map_err(err)?;
    if response.status()==reqwest::StatusCode::TOO_MANY_REQUESTS{return Err(note_museum_cooldown(&state,&provider,&response))}
    response.error_for_status().map_err(err)?.json().await.map_err(err)
}
#[tauri::command]
async fn met_query(path:String,state:State<'_,AppState>)->Result<Value,String>{
    if path.len()>1024{return Err("馆藏查询过长".into())}
    let valid=if let Some(id)=path.strip_prefix("v1/objects/"){!id.is_empty()&&id.bytes().all(|b|b.is_ascii_digit())}
        else{path.starts_with("v1.1/search?")};
    if !valid{return Err("无效的大都会查询".into())}
    let url=format!("https://collectionapi.metmuseum.org/public/collection/{path}");
    museum_cooldown(&state,"met")?;
    {let mut next=state.museum_pacing.lock().await;if let Some(wait)=next.checked_duration_since(Instant::now()){tokio::time::sleep(wait).await;}museum_cooldown(&state,"met")?;*next=Instant::now()+Duration::from_millis(400);}
    let response=state.client.get(url).timeout(Duration::from_secs(30)).send().await.map_err(err)?;
    if response.status()==reqwest::StatusCode::TOO_MANY_REQUESTS{return Err(note_museum_cooldown(&state,"met",&response))}
    response.error_for_status().map_err(err)?.json().await.map_err(err)
}
#[tauri::command]
async fn web_image_search(query:String,state:State<'_,AppState>)->Result<Value,String>{
    if query.trim().is_empty()||query.len()>1000{return Err("无效的搜图词".into())}
    let secret=credential("https://api.search.brave.com")?.get_password().map_err(|_|"请先在偏好中保存 Brave Search API Key".to_string())?;
    count_brave_request(&state,"images")?;
    let response=state.client.get("https://api.search.brave.com/res/v1/images/search")
        .query(&[("q",query.as_str()),("count","20"),("spellcheck","false"),("safesearch","off")])
        .header("X-Subscription-Token",secret).timeout(Duration::from_secs(30)).send().await
        .map_err(|_|"无法连接全网搜图服务，请检查网络".to_string())?;
    if !response.status().is_success(){return Err(format!("全网搜图返回 HTTP {}，请检查密钥或额度",response.status()))}
    response.json().await.map_err(|_|"全网搜图返回了无效响应".to_string())
}
#[tauri::command]
async fn web_page_search(query:String,state:State<'_,AppState>)->Result<Value,String>{
    if query.trim().is_empty()||query.len()>400||query.split_whitespace().count()>50{return Err("无效的网页检索词".into())}
    let secret=credential("https://api.search.brave.com")?.get_password().map_err(|_|"请先在偏好中保存 Brave Search API Key".to_string())?;
    count_brave_request(&state,"web")?;
    let response=state.client.get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q",query.as_str()),("count","10"),("safesearch","moderate")])
        .header("X-Subscription-Token",secret).timeout(Duration::from_secs(30)).send().await
        .map_err(|_|"无法连接网页检索服务，请检查网络".to_string())?;
    if !response.status().is_success(){return Err(format!("网页检索返回 HTTP {}，请检查密钥或额度",response.status()))}
    response.json().await.map_err(|_|"网页检索返回了无效响应".to_string())
}
#[tauri::command]
async fn wikidata_artist_search(query:String,language:String,state:State<'_,AppState>)->Result<Value,String>{
    if query.trim().is_empty()||query.chars().count()>120||query.contains(['\n','\r'])||!(language=="zh"||language=="en"){
        return Err("无效的作者身份查询".into())
    }
    let response=state.client.get("https://www.wikidata.org/w/api.php")
        .query(&[("action","wbsearchentities"),("format","json"),("type","item"),("limit","5"),("search",query.as_str()),("language",language.as_str())])
        .timeout(Duration::from_secs(8)).send().await.map_err(|_|"作者身份服务暂不可用".to_string())?;
    if !response.status().is_success(){return Err(format!("作者身份服务返回 HTTP {}",response.status()))}
    response.json().await.map_err(|_|"作者身份服务返回了无效响应".to_string())
}
fn public_page_ip(ip:std::net::IpAddr)->bool {
    match ip {
        std::net::IpAddr::V4(v)=>{
            let [a,b,c,_]=v.octets();
            !v.is_private()&&!v.is_loopback()&&!v.is_link_local()&&!v.is_broadcast()&&!v.is_unspecified()&&!v.is_multicast()&&!v.is_documentation()
                &&a!=0&&a<240&&!(a==100&&(64..=127).contains(&b))&&!(a==198&&(b==18||b==19))&&!(a==192&&b==0&&c==0)
        },
        std::net::IpAddr::V6(v)=>{
            let segments=v.segments();
            (segments[0]&0xe000)==0x2000 && !(segments[0]==0x2001&&(segments[1]==0||segments[1]==0xdb8)) && segments[0]!=0x2002
        },
    }
}
fn source_page_url(raw:&str)->Result<reqwest::Url,String>{
    if raw.len()>2048{return Err("来源地址过长".into())}
    let mut url=reqwest::Url::parse(raw).map_err(|_|"无效的来源地址".to_string())?;
    let host=url.host_str().unwrap_or("").trim_end_matches('.');
    if url.scheme()!="https"||url.port().is_some_and(|p|p!=443)||!url.username().is_empty()||url.password().is_some()
        ||!host.contains('.')||host.parse::<std::net::IpAddr>().is_ok()||host.ends_with(".localhost")||host.ends_with(".local")||host.ends_with(".internal"){
        return Err("只读取公开 HTTPS 来源网页".into())
    }
    url.set_fragment(None);Ok(url)
}
fn declared_charset(value:&str)->Option<String>{
    let lower=value.to_ascii_lowercase();
    let at=lower.find("charset")?;
    let rest=lower[at+7..].trim_start();
    let rest=rest.strip_prefix('=')?.trim_start().trim_start_matches(['\'', '"']);
    let charset:String=rest.chars().take_while(|ch|ch.is_ascii_alphanumeric()||*ch=='-'||*ch=='_').collect();
    if charset.is_empty(){None}else{Some(charset)}
}
fn decode_public_page(bytes:Vec<u8>,content_type:&str)->Result<String,String>{
    let header_charset=declared_charset(content_type);
    let prefix=String::from_utf8_lossy(&bytes[..bytes.len().min(4096)]).to_ascii_lowercase();
    let meta_charset=prefix.split("<meta").skip(1).take(8).filter_map(|tag|declared_charset(tag.split('>').next().unwrap_or(""))).next();
    if [header_charset,meta_charset].into_iter().flatten().any(|charset|charset!="utf-8"&&charset!="utf8"){
        return Err("来源页声明了暂不支持的文字编码，已保留来源线索但不复核正文".into())
    }
    String::from_utf8(bytes).map_err(|_|"来源页不是有效的 UTF-8，已保留来源线索但不复核正文".into())
}
async fn read_public_page(raw:String)->Result<Value,String>{
    let mut url=source_page_url(&raw)?;
    for redirect in 0..=2 {
        let host=url.host_str().ok_or("无效来源主机")?.to_string();
        let addresses:Vec<_>=tokio::time::timeout(Duration::from_secs(3),tokio::net::lookup_host((host.as_str(),443))).await
            .map_err(|_|"来源页域名解析超时".to_string())?.map_err(|_|"来源页域名无法解析".to_string())?.collect();
        if addresses.is_empty()||addresses.iter().any(|address|!public_page_ip(address.ip())){return Err("来源页指向非公开网络地址".into())}
        // Pin validated DNS addresses and bypass proxies for arbitrary source pages.
        // Existing fixed museum and AI API clients continue using system proxies.
        let client=reqwest::Client::builder().no_proxy().resolve_to_addrs(&host,&addresses)
            .redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(8)).user_agent("AtelierGallery/0.1 source-review").build().map_err(err)?;
        let mut response=client.get(url.clone()).send().await.map_err(|_|"来源页连接失败".to_string())?;
        if response.status().is_redirection(){
            if redirect==2{return Err("来源页重定向过多".into())}
            let location=response.headers().get(reqwest::header::LOCATION).and_then(|value|value.to_str().ok()).ok_or("来源页重定向无效")?;
            url=source_page_url(url.join(location).map_err(err)?.as_str())?;continue
        }
        if !response.status().is_success(){return Err(format!("来源页返回 HTTP {}",response.status()))}
        let content_type=response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value|value.to_str().ok()).unwrap_or("").to_string();
        if !(content_type.starts_with("text/html")||content_type.starts_with("application/xhtml+xml")||content_type.starts_with("text/plain")){return Err("来源不是可读取的文字网页".into())}
        let limit=512*1024;
        let mut bytes=Vec::new();
        while let Some(chunk)=response.chunk().await.map_err(|_|"来源页读取失败".to_string())? {
            let remaining=limit-bytes.len();
            bytes.extend_from_slice(&chunk[..chunk.len().min(remaining)]);
            if bytes.len()>=limit{break}
        }
        let html=decode_public_page(bytes,&content_type)?;
        return Ok(json!({"url":url.as_str(),"html":html}))
    }
    Err("无法读取来源页".into())
}
#[tauri::command]
async fn read_source_page(url:String)->Result<Value,String>{
    tokio::time::timeout(Duration::from_secs(12),read_public_page(url)).await.map_err(|_|"来源页读取超时".to_string())?
}
#[tauri::command]
async fn cache_image(id:u64,url:String,variant:String,app:tauri::AppHandle,state:State<'_,AppState>)->Result<String,String>{
    let validated=image_url(&url)?;
    let museum=match validated.host_str(){Some("openaccess-cdn.clevelandart.org")=>Some("cleveland"),Some("www.artic.edu")=>Some("chicago"),_=>None};
    let (directory,suffix)=match variant.as_str(){"preview"=>("cache/thumbnails",""),"medium"=>("cache/medium-resolution","-medium"),"hd"=>("cache/high-resolution","-hd"),"original"=>("cache/originals","-original"),"collection"=>("collection/originals","-original"),_=>return Err("无效图片版本".into())};
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
    if let Some(provider)=museum{museum_cooldown(&state,provider)?;}else if variant=="original"||variant=="collection"{check_original_cooldown(&state)?;}else{check_cooldown(&state.image_cooldown,"图片下载")?;}
    let _chicago_permit=if museum==Some("chicago"){Some(state.chicago_downloads.acquire().await.map_err(err)?)}else{None};
    if museum==Some("chicago"){let mut next=state.chicago_image_pacing.lock().await;if let Some(wait)=next.checked_duration_since(Instant::now()){tokio::time::sleep(wait).await;}museum_cooldown(&state,"chicago")?;*next=Instant::now()+Duration::from_secs(1);}
    let response=state.client.get(validated).timeout(Duration::from_secs(if variant=="original"||variant=="collection"{300}else{45})).send().await.map_err(err)?;
    if response.status()==reqwest::StatusCode::TOO_MANY_REQUESTS{
        return Err(if let Some(provider)=museum{note_museum_cooldown(&state,provider,&response)}else if variant=="original"||variant=="collection"{note_original_rate_limit(&state,&response)}else{note_cooldown(&state.image_cooldown,&response,"图片下载")})
    }
    let mut response=response.error_for_status().map_err(err)?;
    let ext=match response.headers().get("content-type").and_then(|v|v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or(""){"image/jpeg"=>"jpg","image/png"=>"png","image/webp"=>"webp",_=>return Err("不支持的图片类型".into())};
    fs::create_dir_all(root.join(directory)).map_err(err)?;let relative=format!("{directory}/{name}.{ext}");
    let limit=if variant=="original"||variant=="collection"{512_u64*1024*1024}else{32_u64*1024*1024};
    if response.content_length().unwrap_or(0)>limit{return Err("图片超过下载大小限制，请从馆藏来源页查看".into())}
    let temporary=root.join(directory).join(format!(".{name}-{}-{}.partial",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos()));
    let total=response.content_length();
    let result:Result<String,String>=async {
        let mut file=tokio::fs::File::create(&temporary).await.map_err(err)?;
        let mut received=0_u64;
        let mut last_emit=Instant::now();
        let mut last_bytes=0_u64;
        while let Some(chunk)=response.chunk().await.map_err(err)?{
            received+=chunk.len() as u64;
            if received>limit{return Err("图片超过下载大小限制，请从馆藏来源页查看".into())}
            file.write_all(&chunk).await.map_err(err)?;
            let elapsed=last_emit.elapsed();
            if elapsed>=Duration::from_millis(200)||total.is_some_and(|size|received>=size){
                let speed_bps=((received-last_bytes) as f64/elapsed.as_secs_f64().max(0.001)) as u64;
                let _=app.emit("image-download-progress",json!({"id":id,"variant":variant,"received":received,"total":total,"speedBps":speed_bps}));
                last_emit=Instant::now();last_bytes=received;
            }
        }
        let _=app.emit("image-download-progress",json!({"id":id,"variant":variant,"received":received,"total":total,"speedBps":0}));
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
    let s=state.library.lock().map_err(err)?;
    Ok(webview_path(&resolve_image_path(&s.root,&relative)?))
}
fn resolve_image_path(root:&Path,relative:&str)->Result<PathBuf,String>{
    let supplied=Path::new(relative);
    if supplied.is_absolute()||supplied.components().any(|part|!matches!(part,std::path::Component::Normal(_))){return Err("无效的本地图片路径".into())}
    let path=root.join(supplied).canonicalize().map_err(|_|"本地图片尚未下载".to_string())?;
    let permitted=IMAGE_DIRS.iter().any(|directory|root.join(directory).canonicalize().is_ok_and(|base|path.starts_with(base)));
    if !permitted||!path.is_file(){return Err("无效的本地图片路径".into())}
    Ok(path)
}
#[tauri::command]
fn reveal_artwork_file(relative:String,state:State<AppState>)->Result<(),String>{
    let root=state.library.lock().map_err(err)?.root.clone();
    let path=resolve_image_path(&root,&relative)?;
    #[cfg(target_os="windows")]
    std::process::Command::new("explorer.exe").arg("/select,").arg(webview_path(&path)).spawn().map_err(err)?;
    #[cfg(target_os="macos")]
    std::process::Command::new("open").arg("-R").arg(path).spawn().map_err(err)?;
    #[cfg(all(not(target_os="windows"),not(target_os="macos")))]
    std::process::Command::new("xdg-open").arg(path.parent().ok_or("图片目录不存在")?).spawn().map_err(err)?;
    Ok(())
}
#[tauri::command]
fn set_artwork_wallpaper(relative:String,state:State<AppState>)->Result<(),String>{
    let root=state.library.lock().map_err(err)?.root.clone();
    let source=resolve_image_path(&root,&relative)?;
    #[cfg(target_os="windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        let extension=source.extension().and_then(|value|value.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(extension.as_str(),"jpg"|"png"){return Err("Windows 壁纸需要 JPG 或 PNG 图片；此作品的本地版本暂不支持".into())}
        let directory=root.join("wallpapers");
        fs::create_dir_all(&directory).map_err(err)?;
        let unique=std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(err)?.as_nanos();
        let destination=directory.join(format!("wallpaper-{unique}.{extension}"));
        fs::copy(source,&destination).map_err(err)?;
        let path=webview_path(&destination);
        let mut wide:Vec<u16>=std::ffi::OsStr::new(&path).encode_wide().chain(std::iter::once(0)).collect();
        #[link(name="user32")]
        extern "system" {fn SystemParametersInfoW(action:u32,param:u32,value:*mut std::ffi::c_void,flags:u32)->i32;}
        // SPI_SETDESKWALLPAPER with profile persistence and a shell refresh.
        let applied=unsafe{SystemParametersInfoW(0x0014,0,wide.as_mut_ptr().cast(),0x01|0x02)};
        if applied==0{let _=fs::remove_file(&destination);return Err(format!("设置壁纸失败：{}",std::io::Error::last_os_error()))}
        Ok(())
    }
    #[cfg(not(target_os="windows"))]
    {let _=source;Err("设置桌面壁纸目前仅支持 Windows".into())}
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
    let _downloads=state.downloads.acquire_many(2).await.map_err(err)?;
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
    for directory in ["cache/thumbnails","cache/medium-resolution","cache/high-resolution","cache/originals","images"] {
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
fn ai_text(value:&Value)->Result<String,String>{
    let choice=&value["choices"][0];
    let content=&choice["message"]["content"];
    let text=match content {
        Value::String(text)=>Some(text.clone()),
        Value::Array(parts)=>Some(parts.iter().filter_map(|part|{
            if !part["type"].is_null() && part["type"]!="text" && part["type"]!="output_text" {return None}
            part.as_str().or_else(||part["text"].as_str()).or_else(||part["text"]["value"].as_str())
        }).collect::<Vec<_>>().join("")),
        Value::Object(_)=>content["text"].as_str().or_else(||content["text"]["value"].as_str()).map(str::to_string),
        _=>None,
    }.or_else(||choice["text"].as_str().map(str::to_string))
     .or_else(||value["output_text"].as_str().map(str::to_string));
    if let Some(text)=text.filter(|text|!text.trim().is_empty()){return Ok(text)}
    if let Some(refusal)=choice["message"]["refusal"].as_str(){return Err(format!("AI 拒绝了请求：{}",refusal.chars().take(160).collect::<String>()))}
    if choice["finish_reason"]=="length" {return Err("AI 输出长度不足，未返回可用正文".into())}
    if value["error"].is_object(){return Err("AI 服务返回了错误对象，请检查模型和 API 地址".into())}
    Err("AI 响应没有可用正文；请检查所选模型是否支持 Chat Completions 文本输出".into())
}
#[tauri::command]
async fn ai_plan(base_url:String,model:String,key:String,messages:Value,state:State<'_,AppState>)->Result<String,String>{
    let base=endpoint(&base_url)?;let url=format!("{}/chat/completions",base.as_str().trim_end_matches('/'));
    let secret=if key.is_empty(){credential(&base_url)?.get_password().unwrap_or_default()}else{key};
    for max_tokens in [900,4096] {
        let mut request=state.client.post(&url).json(&json!({"model":model,"messages":messages,"temperature":0.5,"max_tokens":max_tokens}));
        if !secret.is_empty(){request=request.bearer_auth(&secret);}
        let response=request.send().await.map_err(|_|"无法连接 AI 服务，请检查地址和网络".to_string())?;
        let status=response.status();if !status.is_success(){return Err(format!("AI 服务返回 {status}，请检查密钥、模型和额度"))}
        let value:Value=response.json().await.map_err(|_|"AI 服务返回了非 JSON 响应".to_string())?;
        if max_tokens==900 && value["choices"][0]["finish_reason"]=="length" {continue}
        return ai_text(&value)
    }
    Err("AI 输出长度不足，未返回可用正文".into())
}
fn remember_recovered_location(pointer:&Path,root:&Path)->Result<(),String>{
    let backup=pointer.with_file_name("location.previous.json");
    if !backup.exists(){fs::copy(pointer,&backup).map_err(err)?;}
    atomic_write(pointer,serde_json::to_string(root).map_err(err)?.as_bytes())
}
fn recover_library_location(pointer:&Path,missing:&Path,default:&Path)->Result<PathBuf,String>{
    loop {
        let choice=rfd::MessageDialog::new()
            .set_title("拾色 · 资料库目录不可用")
            .set_level(rfd::MessageLevel::Warning)
            .set_description(format!("找不到之前的资料库：{}\n\n选“是”可指定已有资料库文件夹；选“否”使用本机资料库：{}；选“取消”退出并等待同步完成。不会删除原资料。",webview_path(missing),webview_path(default)))
            .set_buttons(rfd::MessageButtons::YesNoCancel)
            .show();
        let root=match choice {
            rfd::MessageDialogResult::Yes=>{
                let Some(folder)=rfd::FileDialog::new().set_title("选择含 library.json 的已有资料库").pick_folder() else {continue};
                let data=match fs::read_to_string(folder.join("library.json")){
                    Ok(data)=>data,
                    Err(_)=>{rfd::MessageDialog::new().set_title("不是有效的资料库").set_description("所选文件夹缺少 library.json，请重新选择。").show();continue}
                };
                if let Err(error)=validate_library(&data){rfd::MessageDialog::new().set_title("资料库格式不兼容").set_description(error).show();continue}
                folder
            },
            rfd::MessageDialogResult::No=>{fs::create_dir_all(default).map_err(err)?;default.to_path_buf()},
            _=>return Err("资料库恢复已取消".into()),
        };
        if !root.is_dir(){continue}
        remember_recovered_location(pointer,&root)?;
        return Ok(root)
    }
}
fn main(){let result=tauri::Builder::default().plugin(tauri_plugin_opener::init()).setup(|app|{
    let config=app.path().app_config_dir()?;let pointer=config.join("location.json");
    let default=app.path().app_data_dir()?.join("Library");
    let root:PathBuf=if pointer.exists(){let configured:PathBuf=serde_json::from_str(&fs::read_to_string(&pointer)?)?;if configured.is_dir(){configured}else{recover_library_location(&pointer,&configured,&default)?}}else{default};
    for directory in IMAGE_DIRS {fs::create_dir_all(root.join(directory))?;app.asset_protocol_scope().allow_directory(root.join(directory),true)?;}
    let client=reqwest::Client::builder().user_agent("AtelierGallery/0.1 (personal open-art desktop viewer)").timeout(Duration::from_secs(45)).redirect(reqwest::redirect::Policy::none()).build()?;
    app.manage(AppState{library:Mutex::new(LibraryState{root,last:None}),brave_usage_lock:Mutex::new(()),client,downloads:tokio::sync::Semaphore::new(2),chicago_downloads:tokio::sync::Semaphore::new(1),original_cooldown:Mutex::new(None),query_cooldown:Mutex::new(None),image_cooldown:Mutex::new(None),museum_cooldowns:Mutex::new(HashMap::new()),query_pacing:tokio::sync::Mutex::new(Instant::now()),museum_pacing:tokio::sync::Mutex::new(Instant::now()),chicago_image_pacing:tokio::sync::Mutex::new(Instant::now())});Ok(())
}).invoke_handler(tauri::generate_handler![load_library,save_library,library_backup_summary,restore_library_backup,library_directory,choose_directory,switch_library,commons_query,museum_query,met_query,web_image_search,web_page_search,brave_usage,wikidata_artist_search,read_source_page,cached_image,cache_image,image_path,reveal_artwork_file,set_artwork_wallpaper,clear_image_cache,save_api_key,has_api_key,ai_plan,open_external]).run(tauri::generate_context!());
    if let Err(error)=result{if !error.to_string().contains("资料库恢复已取消"){
        rfd::MessageDialog::new().set_title("拾色启动失败").set_level(rfd::MessageLevel::Error).set_description(error.to_string()).show();
    }}
}

#[cfg(test)]
mod tests {use super::*;
    #[test]fn brave_usage_counts_requests_by_month_and_survives_reload(){
        let root=fixture().root;
        let state=AppState{library:Mutex::new(LibraryState{root:root.clone(),last:None}),brave_usage_lock:Mutex::new(()),client:reqwest::Client::new(),downloads:tokio::sync::Semaphore::new(1),chicago_downloads:tokio::sync::Semaphore::new(1),original_cooldown:Mutex::new(None),query_cooldown:Mutex::new(None),image_cooldown:Mutex::new(None),museum_cooldowns:Mutex::new(HashMap::new()),query_pacing:tokio::sync::Mutex::new(Instant::now()),museum_pacing:tokio::sync::Mutex::new(Instant::now()),chicago_image_pacing:tokio::sync::Mutex::new(Instant::now())};
        count_brave_request(&state,"web").unwrap();count_brave_request(&state,"images").unwrap();count_brave_request(&state,"web").unwrap();
        let summary=brave_usage_summary(&root).unwrap();
        assert_eq!((summary.web,summary.images),(2,1));
        assert_eq!(summary.history.get(&summary.month).unwrap().web,2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]fn local_image_actions_reject_paths_outside_library(){
        let state=fixture();
        let image=state.root.join("collection/originals/7.jpg");
        fs::create_dir_all(image.parent().unwrap()).unwrap();fs::write(&image,b"image").unwrap();
        assert_eq!(resolve_image_path(&state.root,"collection/originals/7.jpg").unwrap(),image.canonicalize().unwrap());
        assert!(resolve_image_path(&state.root,"../outside.jpg").is_err());
        assert!(resolve_image_path(&state.root,"library.json").is_err());
        assert!(resolve_image_path(&state.root,"collection/originals/missing.jpg").is_err());
        fs::remove_dir_all(state.root).unwrap();
    }
    #[test]fn recovered_location_keeps_original_pointer(){
        let state=fixture();
        let pointer=state.root.join("location.json");
        let old=state.root.join("deleted-gallery");
        let replacement=state.root.join("new-gallery");
        fs::write(&pointer,serde_json::to_string(&old).unwrap()).unwrap();
        remember_recovered_location(&pointer,&replacement).unwrap();
        assert_eq!(serde_json::from_str::<PathBuf>(&fs::read_to_string(&pointer).unwrap()).unwrap(),replacement);
        assert_eq!(serde_json::from_str::<PathBuf>(&fs::read_to_string(state.root.join("location.previous.json")).unwrap()).unwrap(),old);
        fs::remove_dir_all(state.root).unwrap();
    }
    #[test]fn commons_cooldown_prevents_immediate_retries(){
        let until=Mutex::new(Some(Instant::now()+Duration::from_secs(90)));
        assert!(check_cooldown(&until,"查询").unwrap_err().contains("2 分钟"));
        *until.lock().unwrap()=Some(Instant::now()-Duration::from_secs(1));
        assert!(check_cooldown(&until,"查询").is_ok());
    }
    #[test]fn ai_text_accepts_common_completion_shapes(){
        assert_eq!(ai_text(&json!({"choices":[{"message":{"content":"hello"}}]})).unwrap(),"hello");
        assert_eq!(ai_text(&json!({"choices":[{"message":{"content":[{"type":"text","text":"one"},{"type":"reasoning","text":"hidden"},{"type":"text","text":{"value":" two"}}]}}]})).unwrap(),"one two");
        assert_eq!(ai_text(&json!({"choices":[{"text":"legacy"}]})).unwrap(),"legacy");
        assert_eq!(ai_text(&json!({"output_text":"response"})).unwrap(),"response");
    }
    #[test]fn ai_text_explains_empty_or_refused_responses(){
        assert!(ai_text(&json!({"choices":[{"finish_reason":"length","message":{"content":null}}]})).unwrap_err().contains("长度不足"));
        assert!(ai_text(&json!({"choices":[{"message":{"content":null,"refusal":"blocked"}}]})).unwrap_err().contains("blocked"));
        assert!(ai_text(&json!({"choices":[{"message":{"content":null,"reasoning_content":"private"}}]})).unwrap_err().contains("没有可用正文"));
    }
    #[test]fn original_rate_limit_waits_without_blocking_local_reads(){
        let state=AppState{library:Mutex::new(LibraryState{root:PathBuf::new(),last:None}),brave_usage_lock:Mutex::new(()),client:reqwest::Client::new(),downloads:tokio::sync::Semaphore::new(1),chicago_downloads:tokio::sync::Semaphore::new(1),original_cooldown:Mutex::new(None),query_cooldown:Mutex::new(None),image_cooldown:Mutex::new(None),museum_cooldowns:Mutex::new(HashMap::new()),query_pacing:tokio::sync::Mutex::new(Instant::now()),museum_pacing:tokio::sync::Mutex::new(Instant::now()),chicago_image_pacing:tokio::sync::Mutex::new(Instant::now())};
        assert!(check_original_cooldown(&state).is_ok());
        *state.original_cooldown.lock().unwrap()=Some(Instant::now()+Duration::from_secs(90));
        assert!(check_original_cooldown(&state).unwrap_err().contains("2 分钟"));
        *state.original_cooldown.lock().unwrap()=Some(Instant::now()-Duration::from_secs(1));
        assert!(check_original_cooldown(&state).is_ok());
        state.museum_cooldowns.lock().unwrap().insert("cleveland".into(),Instant::now()+Duration::from_secs(90));
        assert!(museum_cooldown(&state,"cleveland").is_err());
        assert!(museum_cooldown(&state,"chicago").is_ok());
        state.museum_cooldowns.lock().unwrap().insert("met".into(),Instant::now()+Duration::from_secs(90));
        assert!(museum_cooldown(&state,"met").is_err());
    }
    #[test]fn native_asset_path_omits_windows_device_prefix(){assert_eq!(webview_path(std::path::Path::new(r"\\?\D:\Gallery\images\1.jpg")),r"D:\Gallery\images\1.jpg");assert_eq!(webview_path(std::path::Path::new(r"\\?\UNC\server\Gallery\1.jpg")),r"\\server\Gallery\1.jpg");}
    #[test]fn reject_untrusted_images(){assert!(image_url("https://upload.wikimedia.org/a.jpg").is_ok());assert!(image_url("https://openaccess-cdn.clevelandart.org/1998.78.14/1998.78.14_print.jpg").is_ok());assert!(image_url("https://www.artic.edu/iiif/2/id/full/843,/0/default.jpg").is_ok());assert!(image_url("https://upload.wikimedia.org.evil.test/a").is_err());assert!(image_url("https://openaccess-cdn.clevelandart.org.evil.test/a_print.jpg").is_err());assert!(image_url("file:///etc/passwd").is_err());}
    #[test]fn met_images_remain_on_the_museum_host(){
        assert!(image_url("https://images.metmuseum.org/CRDImages/ep/original/a.jpg").is_ok());
        assert!(image_url("https://images.metmuseum.org/CRDImages/ep/original/a.JPG").is_ok());
        assert!(image_url("https://images.metmuseum.org.evil.test/CRDImages/a.jpg").is_err());
        assert!(image_url("https://images.metmuseum.org/other/a.jpg").is_err());
        assert!(image_url("https://images.metmuseum.org/CRDImages/a.jpg?redirect=https://example.com").is_err());
    }
    #[test]fn commons_imageinfo_query_is_removed_before_download(){
        let original="https://upload.wikimedia.org/wikipedia/commons/6/66/VanGogh-starry_night_ballance1.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original";
        assert_eq!(image_url(original).unwrap().as_str(),"https://upload.wikimedia.org/wikipedia/commons/6/66/VanGogh-starry_night_ballance1.jpg");
        assert_eq!(image_url("https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/art.jpg/640px-art.jpg?utm_source=commons.wikimedia.org").unwrap().query(),None);
        assert!(image_url("https://upload.wikimedia.org.evil.test/a.jpg?utm_source=commons.wikimedia.org").is_err());
        assert!(image_url("https://www.artic.edu/iiif/2/id/full/843,/0/default.jpg?utm_source=commons.wikimedia.org").is_err());
    }
    #[test]fn endpoint_security(){assert!(endpoint("https://example.com/v1").is_ok());assert!(endpoint("http://127.0.0.1:11434/v1").is_ok());assert!(endpoint("http://example.com/v1").is_err());assert!(endpoint("https://user:secret@example.com").is_err());}
    #[test]fn source_page_rejects_private_targets_and_unsafe_redirects(){
        for url in ["http://example.com/art", "https://127.0.0.1/art", "https://127.1/art", "https://2130706433/art",
            "https://10.0.0.1/art", "https://[::1]/art", "https://museum.local/art", "https://museum.internal/art",
            "https://user:pass@example.com/art", "https://example.com:8443/art", "file:///etc/passwd"] {
            assert!(source_page_url(url).is_err(),"accepted unsafe source: {url}");
        }
        let base=source_page_url("https://museum.example/art/1").unwrap();
        assert_eq!(source_page_url(base.join("../art/2").unwrap().as_str()).unwrap().as_str(),"https://museum.example/art/2");
        assert!(source_page_url(base.join("http://127.0.0.1/admin").unwrap().as_str()).is_err());
        assert!(source_page_url(base.join("https://user@museum.example/private").unwrap().as_str()).is_err());
    }
    #[test]fn source_page_does_not_treat_unsupported_encodings_as_evidence(){
        assert_eq!(decode_public_page("<main>青山</main>".as_bytes().to_vec(),"text/html; charset=UTF-8").unwrap(),"<main>青山</main>");
        assert!(decode_public_page(b"<main>art</main>".to_vec(),"text/html; charset=Shift_JIS").unwrap_err().contains("暂不支持"));
        assert!(decode_public_page(b"<meta charset='windows-1252'><main>art</main>".to_vec(),"text/html").unwrap_err().contains("暂不支持"));
        assert!(decode_public_page(vec![0x3c,0x70,0x3e,0xff],"text/html").unwrap_err().contains("UTF-8"));
    }
    #[test]fn source_page_dns_rejects_non_public_addresses(){
        for ip in ["127.0.0.1","10.1.2.3","172.16.0.1","192.168.1.1","169.254.1.1","100.64.0.1",
            "198.18.0.1","192.0.0.1","224.0.0.1","::1","fe80::1","fc00::1","2001:db8::1","2002:c000:0201::1"] {
            assert!(!public_page_ip(ip.parse().unwrap()),"accepted non-public DNS address: {ip}");
        }
        assert!(public_page_ip("8.8.8.8".parse().unwrap()));
        assert!(public_page_ip("2001:4860:4860::8888".parse().unwrap()));
    }
    fn fixture()->LibraryState {
        static NEXT_ID:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
        let unique=NEXT_ID.fetch_add(1,std::sync::atomic::Ordering::Relaxed);
        let root=std::env::temp_dir().join(format!("atelier-test-{}-{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),unique));
        fs::create_dir_all(root.join("images")).unwrap();LibraryState{root,last:None}
    }
    fn data(label:&str)->String{json!({"version":1,"conversations":[],"saved":[],"label":label}).to_string()}
    #[test]fn backup_and_conflict_protection(){let mut s=fixture();save_snapshot(&mut s,data("first")).unwrap();save_snapshot(&mut s,data("second")).unwrap();assert_eq!(fs::read_to_string(s.root.join("library.backup.json")).unwrap(),data("first"));fs::write(s.root.join("library.json"),data("remote")).unwrap();assert!(save_snapshot(&mut s,data("local")).is_err());assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),data("remote"));fs::remove_dir_all(s.root).unwrap();}
    #[test]fn migration_copies_images_and_keeps_source(){
        let mut s=fixture();let t=fixture();fs::remove_dir(t.root.join("images")).unwrap();
        save_snapshot(&mut s,data("collection")).unwrap();
        fs::write(s.root.join("images/1.jpg"),b"image fixture").unwrap();
        fs::write(s.root.join("brave-usage.json"),r#"{"months":{"2026-10":{"web":2,"images":1}}}"#).unwrap();
        fs::create_dir_all(s.root.join("wallpapers")).unwrap();fs::write(s.root.join("wallpapers/wallpaper.jpg"),b"wallpaper").unwrap();
        copy_library(&s,&t.root).unwrap();
        assert_eq!(fs::read(t.root.join("images/1.jpg")).unwrap(),b"image fixture");
        assert_eq!(fs::read(t.root.join("wallpapers/wallpaper.jpg")).unwrap(),b"wallpaper");
        assert_eq!(read_brave_usage(&t.root).unwrap().months["2026-10"].web,2);
        assert!(s.root.join("library.json").exists());assert!(copy_library(&s,&t.root).is_err());
        fs::remove_dir_all(s.root).unwrap();fs::remove_dir_all(t.root).unwrap();
    }
    #[test]fn malformed_data_does_not_replace_library(){let mut s=fixture();save_snapshot(&mut s,data("good")).unwrap();assert!(save_snapshot(&mut s,"{}".into()).is_err());assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),data("good"));fs::remove_dir_all(s.root).unwrap();}
    #[test]fn explicit_backup_recovery_archives_corrupt_original(){
        let mut s=fixture();save_snapshot(&mut s,data("original")).unwrap();save_snapshot(&mut s,data("recoverable")).unwrap();
        assert_eq!(read_backup_summary(&s.root).unwrap().unwrap().saved,0);
        assert!(restore_backup_snapshot(&mut s).is_err());
        fs::write(s.root.join("library.json"),"{broken data").unwrap();s.last=Some("{broken data".into());
        assert!(save_snapshot(&mut s,data("must-not-overwrite")).is_err());
        let archived=restore_backup_snapshot(&mut s).unwrap();
        assert_eq!(fs::read_to_string(&archived).unwrap(),"{broken data");
        assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),data("original"));
        assert_eq!(fs::read_to_string(s.root.join("library.backup.json")).unwrap(),data("original"));
        assert!(restore_backup_snapshot(&mut s).is_err());
        fs::remove_dir_all(s.root).unwrap();
    }
    #[test]fn invalid_backup_never_replaces_corrupt_library(){
        let mut s=fixture();fs::write(s.root.join("library.json"),"{broken data").unwrap();s.last=Some("{broken data".into());
        fs::write(s.root.join("library.backup.json"),"{}").unwrap();
        assert!(read_backup_summary(&s.root).is_err());
        assert!(restore_backup_snapshot(&mut s).is_err());
        assert_eq!(fs::read_to_string(s.root.join("library.json")).unwrap(),"{broken data");
        fs::remove_dir_all(s.root).unwrap();
    }
    #[test]fn large_library_roundtrip_keeps_backup_and_every_record(){
        let mut source=fixture();let target=fixture();fs::remove_dir(target.root.join("images")).unwrap();
        let saved=(0..1000).map(|id|json!({"id":id,"title":format!("Artwork {id}"),"local":format!("images/{id}-original.jpg")})).collect::<Vec<_>>();
        let conversations=(0..100).map(|id|json!({"id":format!("conversation-{id}"),"messages":[{"role":"user","content":format!("Explore {id}")}]})).collect::<Vec<_>>();
        let first=json!({"version":1,"saved":saved,"conversations":conversations,"viewed":[]}).to_string();
        let started=Instant::now();save_snapshot(&mut source,first.clone()).unwrap();
        let mut second:Value=serde_json::from_str(&first).unwrap();second["viewed"]=json!([{"id":42}]);let second=second.to_string();
        save_snapshot(&mut source,second.clone()).unwrap();copy_library(&source,&target.root).unwrap();
        let restored:Value=serde_json::from_str(&fs::read_to_string(target.root.join("library.json")).unwrap()).unwrap();
        assert_eq!(restored["saved"].as_array().unwrap().len(),1000);
        assert_eq!(restored["conversations"].as_array().unwrap().len(),100);
        assert_eq!(restored["viewed"].as_array().unwrap().len(),1);
        assert_eq!(fs::read_to_string(target.root.join("library.backup.json")).unwrap(),first);
        eprintln!("1000 saved + 100 conversations, two writes and migration: {:?}",started.elapsed());
        fs::remove_dir_all(source.root).unwrap();fs::remove_dir_all(target.root).unwrap();
    }
    #[test]fn clear_cache_preserves_collection_and_legacy_saved_images(){
        let mut s=fixture();
        save_snapshot(&mut s,json!({"version":1,"conversations":[],"saved":[{"local":"images/7-original.jpg"},{"local":"cache/high-resolution/8.jpg"}]}).to_string()).unwrap();
        fs::write(s.root.join("library.backup.json"),json!({"saved":[{"local":"images/6-original.jpg"}]}).to_string()).unwrap();
        for (directory,name) in [("images","7-original.jpg"),("images","6-original.jpg"),("images","9.jpg"),("cache/thumbnails","9.jpg"),("cache/medium-resolution","9.jpg"),("cache/high-resolution","8.jpg"),("cache/originals","9.jpg"),("collection/originals","10.jpg")] {
            let folder=s.root.join(directory);fs::create_dir_all(&folder).unwrap();fs::write(folder.join(name),b"art").unwrap();
        }
        let (files,bytes)=clear_cache_files(&s).unwrap();
        assert_eq!((files,bytes),(4,12));
        assert!(s.root.join("images/7-original.jpg").exists());
        assert!(s.root.join("images/6-original.jpg").exists());
        assert!(s.root.join("cache/high-resolution/8.jpg").exists());
        assert!(s.root.join("collection/originals/10.jpg").exists());
        assert!(!s.root.join("cache/originals/9.jpg").exists());
        assert!(!s.root.join("cache/medium-resolution/9.jpg").exists());
        fs::remove_dir_all(s.root).unwrap();
    }
    #[test]fn migration_copies_separated_images(){
        let mut s=fixture();let target=fixture();fs::remove_dir(target.root.join("images")).unwrap();
        save_snapshot(&mut s,data("separated")).unwrap();
        fs::write(s.root.join("library.backup.json"),data("backup")).unwrap();
        for directory in ["cache/thumbnails","cache/medium-resolution","cache/high-resolution","cache/originals","collection/originals"] {
            fs::create_dir_all(s.root.join(directory)).unwrap();fs::write(s.root.join(directory).join("1.jpg"),directory.as_bytes()).unwrap();
        }
        copy_library(&s,&target.root).unwrap();
        for directory in ["cache/thumbnails","cache/medium-resolution","cache/high-resolution","cache/originals","collection/originals"] {
            assert_eq!(fs::read(target.root.join(directory).join("1.jpg")).unwrap(),directory.as_bytes());
        }
        assert_eq!(fs::read_to_string(target.root.join("library.backup.json")).unwrap(),data("backup"));
        fs::remove_dir_all(s.root).unwrap();fs::remove_dir_all(target.root).unwrap();
    }
}
