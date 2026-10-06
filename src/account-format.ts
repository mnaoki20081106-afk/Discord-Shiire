export type AccountField = { key: string; label: string; value: string; confidence: "format" | "candidate" | "unknown" };
export type FormatSource = { id: string; title: string; seller: string; url: string; formats: string[]; declarations: string[]; aliases?: string[] };
export type FormatCandidate = { format: string; sources: string[]; fields: AccountField[] };
export type ParsedAccount = { candidates: FormatCandidate[]; fields: AccountField[]; warnings: string[]; separators: string[] };

export const FIELD_LABELS: Record<string, string> = {
  username: "XアカウントID", password: "Xパスワード", email: "メールアドレス",
  emailPassword: "メールパスワード", recoveryEmail: "復旧用メール", recoveryPassword: "復旧用パスワード",
  phone: "電話番号", totp: "2FAキー", authToken: "auth_token", ct0: "ct0",
  refreshToken: "メールRefresh Token", clientId: "メールClient ID", cookies: "Cookies",
  followers: "フォロワー数", tweets: "投稿数", year: "登録年", premiumDue: "Premium期限",
  emailToken: "メールトークン", emailTotp: "メール2FAキー", verificationUrl: "認証用URL", backupCode: "2FAバックアップコード", twoFactorId: "ID_2FA_code（原文項目）", additionalEmail: "追加メール", profileUrl: "プロフィールURL", deviceToken: "Device Token", data: "Data", device: "デバイス情報", secretToken: "Secret Token", emailAccessInfo: "メールアクセス情報", oauthToken: "OAuth Token", oauthSecret: "OAuth Token Secret", oauth2: "メールOAuth2", registrationDate: "登録日時", country: "国・地域", avatar: "アバター", userAgent: "User Agent", unknown: "未判別"
};

export function templateFields(template: string): { keys: string[]; separators: string[]; trailingSeparator?: string } {
  const parts = template.normalize("NFKC").trim().replace(/two-factor authentication/gi,"2FA").replace(/reg\.date/gi,"RegistrationDate").replace(/dp\.mail/gi,"AdditionalEmail").replace(/2-FA/gi,"2FA").split(/(-{1,}|—|–|::|:|\||;|\t|\.|,)/);
  const trailingSeparator=parts[parts.length-1] === "" ? parts.splice(-2)[0] : undefined;
  if (parts.length < 3 || parts.length > 49 || parts.some(p => !p.trim())) {
    throw new Error("Formatは Login:Password:Email:2FA:Token のように入力してください");
  }
  const keys: string[] = [], separators: string[] = [];
  const aliases: Record<string, string> = {
    login:"username",log:"username",xusername:"username",profile:"username","2fadirectkey":"totp",logintwitter:"username",twitterlogin:"username",pastwitter:"password",tokentwitter:"authToken",mailtwitter:"email",pasmailtwitter:"emailPassword",tokenmail:"emailToken",twittermail:"email",profilelink:"profileUrl",link:"profileUrl",ct0token:"ct0",cookiesjson:"cookies",subscriptions:"followers",data:"data",follownumber:"followers",devicetoken:"deviceToken","2fakeylink":"totp",linkto2fakey:"totp",loginemail:"email",emailforlogin:"email",passemail:"emailPassword",fake:"unknown",device:"device",secrettoken:"secretToken",username:"username",user:"username",id:"username",account:"username",
    password:"password",pass:"password",pwd:"password",twitterpassword:"password",xpassword:"password",
    email:"email",mail:"email",loginmail:"email",emailaddress:"email",emailusername:"email",mailusername:"email",
    emailpassword:"emailPassword",mailpassword:"emailPassword",mailpass:"emailPassword",passmail:"emailPassword",emailpass:"emailPassword",
    emailrecovery:"recoveryEmail",recoveryemail:"recoveryEmail",backupemail:"recoveryEmail",
    attachpassword:"recoveryPassword",recoverypassword:"recoveryPassword",
    phone:"phone",phonenumber:"phone",number:"phone",
    "2fa":"totp",twofactorauthentication:"totp",twofactor:"totp",totp:"totp",secret:"totp",key2fa:"totp","2fasecret":"totp","2facode":"totp","2fakey":"totp",twofactorverification:"totp","2famail":"emailTotp",
    token:"authToken",authtoken:"authToken",auth:"authToken",aoutoken:"authToken",verificationtoken:"authToken",accesstoken:"authToken",
    ct0:"ct0",cto:"ct0",refreshtoken:"refreshToken",clientid:"clientId",clientld:"clientId",
    cookies:"cookies",cookie:"cookies",followers:"followers",counts:"followers",subs:"followers",tweet:"tweets",tweets:"tweets",
    year:"year",premiumduedate:"premiumDue",tempmailtoken:"emailToken",emailtoken:"emailToken",
    verificationurl:"verificationUrl",firstmail:"verificationUrl",additionalpassword:"recoveryPassword",backupcode:"backupCode",twitteremail:"email",twitterusername:"username",twitter2fa:"totp","2fakeyofemail":"emailTotp",passwordmail:"emailPassword",tweetcount:"tweets",followercount:"followers",emaillogin:"email",emailaccessinfo:"emailAccessInfo",authorizationtoken:"authToken",tokenauthorization:"authToken",authenticationtoken:"authToken",id2facode:"twoFactorId",authorization:"authToken",emailid:"clientId",yearcreated:"year",passwordpost:"emailPassword",passwordemail:"emailPassword",appid:"clientId",verificationemail:"email",secondaryemail:"recoveryEmail",secondaryemailpassword:"recoveryPassword",backupemailpassword:"recoveryPassword",tinyhostemail:"email",hotmail:"email",additionalemail:"additionalEmail",邮箱密码:"emailPassword",邮箱令牌:"emailToken",邮箱客户端:"clientId",jsoncookies:"cookies","2fasecretcode":"totp",none:"unknown",uid:"clientId",posts:"tweets",registrationcountry:"country",oauthtoken:"oauthToken",authtokensecret:"oauthSecret",oauthtokensecret:"oauthSecret",accesstokensecret:"oauthSecret","accesstoken(userid+token":"oauthToken",oauth2:"oauth2",registrationdate:"registrationDate",regdate:"registrationDate",country:"country",avatar:"avatar",useragent:"userAgent",clientuid:"clientId",unknown:"unknown"
  };
  for (let i=0;i<parts.length;i++) {
    if (i%2) { separators.push(parts[i]!); continue; }
    const label=parts[i]!.trim().replace(/^\(|\)$/g,"");
    const normalized=label.toLowerCase().replace(/[\s_\-\u200b-\u200d\ufeff]+/g,"");
    let key=aliases[normalized];
    if (!key) throw new Error("Formatに未対応の項目名があります。項目名を確認してください");
    if (key==="password" && !["twitterpassword","xpassword"].includes(normalized) && keys.includes("email")) key="emailPassword";
    keys.push(key);
  }
  return {keys,separators,trailingSeparator};
}

function validField(key: string, value: string): boolean {
  if (!value) return true; // Delivery exports may contain empty/absent fields; keep their positions.
  switch (key) {
    case "username": return /^@?[A-Za-z0-9_]{1,15}$/.test(value);
    case "email": case "recoveryEmail": case "additionalEmail": return /^[^\s@:|;]+@[^\s@:|;]+\.[^\s@:|;]+$/.test(value);
    case "authToken": return /^[a-fA-F0-9]{40}$/.test(value);
    case "ct0": return /^[a-fA-F0-9]{32,256}$/.test(value);
    case "emailTotp": case "totp": return /^(?:[A-Z2-7][A-Z2-7\s-]{14,126}[A-Z2-7]=*|otpauth:\/\/[^\s]+|https:\/\/[^\s]+)$/i.test(value);
    case "phone": return /^\+?[\d ()-]{5,24}$/.test(value);
    case "year": return /^(?:19|20)\d{2}$/.test(value);
    case "followers": case "tweets": return /^\d+$/.test(value);
    case "clientId": return /^[\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12}$/.test(value) || /^[\da-zA-Z_-]{16,64}$/.test(value);
    case "profileUrl": case "verificationUrl": return /^https?:\/\//.test(value);
    case "cookies": return /^[\[{]/.test(value) || /(?:^|[;\s])(?:auth_token|ct0)=/.test(value) || value.includes("\t");
    case "userAgent": return /^(?:Mozilla\/|Opera\/|Dalvik\/|Twitter\/)/i.test(value);
    default:return true;
  }
}

export function matchFormat(raw: string, format: string): AccountField[] | null {
  const {keys,separators,trailingSeparator}=templateFields(format);
  if (trailingSeparator) {if (!raw.endsWith(trailingSeparator))return null;raw=raw.slice(0,-trailingSeparator.length);}
  const interpretations: AccountField[][]=[];
  let budget=1500;
  function accepts(key:string,value:string):boolean {
    if (!validField(key,value)) return false;
    const embedded=separators.filter(s=>value.includes(s));
    if (!embedded.length) return true;
    if (["cookies","profileUrl","verificationUrl","totp","emailToken","refreshToken","emailTotp"].includes(key))return true;
    if (["email","recoveryEmail","additionalEmail"].includes(key) && embedded.every(s=>s==="." || s==="-"))return true;
    if (["phone","clientId"].includes(key) && embedded.every(s=>s==="-"))return true;
    return false;
  }
  function walk(index:number,offset:number,fields:AccountField[]) {
    if (--budget<0 || interpretations.length>1)return;
    const key=keys[index]!;
    const add=(value:string,end:number)=>{
      if (!accepts(key,value))return;
      const next=[...fields,{key,label:FIELD_LABELS[key]!,value,confidence:"format" as const}];
      if (index===keys.length-1) { if(next.some(f=>f.value))interpretations.push(next); }
      else walk(index+1,end,next);
    };
    if (index===keys.length-1) {add(raw.slice(offset),raw.length);return;}
    const separator=separators[index]!;
    let pos=raw.indexOf(separator,offset);
    while(pos!==-1 && budget>=0 && interpretations.length<=1) {
      if (!/^-+$/.test(separator) || (raw[pos-1]!=="-" && raw[pos+separator.length]!=="-")) add(raw.slice(offset,pos),pos+separator.length);
      pos=raw.indexOf(separator,pos+separator.length);
    }
  }
  walk(0,0,[]);
  return budget>=0 && interpretations.length===1?interpretations[0]!:null;
}

export function parseAccount(raw: string, catalog: FormatSource[], options: { productId?: string; format?: string; separator?: string } = {}): ParsedAccount {
  // Trim pasted line endings only. Passwords and other values retain exact bytes.
  raw=raw.replace(/\r?\n$/g,"");
  if (!raw || raw.length>4000 || /[\r\n]/.test(raw)) throw new Error("1アカウント分の納品文字列を入力してください（最大4,000文字）");
  const warnings: string[]=[], candidates: FormatCandidate[]=[];
  const separators=[...new Set(raw.match(/-{2,}|—|–|::|:|\||;|\t/g)??[])];
  const selected=options.productId?catalog.filter(s=>s.id===options.productId):catalog;
  if (options.productId && !selected.length) throw new Error("購入元の商品が見つかりません");
  const byFormat=new Map<string,string[]>();
  for (const source of selected) for (const f of source.formats) {
    const ids=byFormat.get(f)??[];ids.push(source.id);byFormat.set(f,ids);
  }
  if (options.format) { templateFields(options.format); byFormat.clear();byFormat.set(options.format,[]); }
  for (const [format,sources] of byFormat) {
    if (options.separator && !templateFields(format).separators.includes(options.separator)) continue;
    const fields=matchFormat(raw,format);
    if (fields) { candidates.push({format,sources,fields}); for(const sep of templateFields(format).separators)if(!separators.includes(sep))separators.push(sep); }
  }
  // Duplicate declarations with synonymous labels count as one interpretation.
  const interpretations=new Map<string,FormatCandidate>();
  for (const candidate of candidates) {
    const signature=JSON.stringify(candidate.fields.map(f=>[f.key,f.value]));
    const previous=interpretations.get(signature);
    if (previous) previous.sources=[...new Set([...previous.sources,...candidate.sources])];
    else interpretations.set(signature,candidate);
  }
  const unique=[...interpretations.values()];
  if (unique.length===1) {
    if (unique[0]!.fields.some(f=>!f.value)) warnings.push("空欄の項目があります。省略位置を保持して表示しています。");
    if(new Set(unique[0]!.fields.map(f=>f.key)).size !== unique[0]!.fields.length) warnings.push("同じ項目名が複数あります。商品説明の順序を確認してください。");
    warnings.push("商品説明の形式との一致です。ログインや各キーの有効性は検証していません。");
    return {candidates:unique,fields:unique[0]!.fields,warnings,separators};
  }
  if (unique.length>1) warnings.push("複数の形式に一致しています。購入元の商品またはFormatを指定してください。");
  else warnings.push(options.format?"指定したFormatと一致しません。順序・区切り文字・項目数を確認してください。":"登録形式に一致しません。購入元の商品説明のFormatを指定してください。");
  // Unlabelled data alone cannot prove which password/mail/token is which.
  const delimiter=options.separator || [...separators].sort((a,b)=>b.length-a.length)[0];
  const values=delimiter?raw.split(delimiter):[raw];
  const fields=values.map((value,i):AccountField=>{
    let key="unknown";
    if (/^[^\s@:|;]+@[^\s@:|;]+\.[^\s@:|;]+$/.test(value))key="email";
    else if (/^[a-fA-F0-9]{40}$/.test(value))key="authToken";
    else if (/^[A-Z2-7]{16,128}=*$/i.test(value))key="totp";
    else if (/^@?[A-Za-z0-9_]{1,15}$/.test(value) && i===0)key="username";
    return {key,label:(key==="unknown"?`未判別（項目${i+1}）`:FIELD_LABELS[key]+"候補"),value,confidence:key==="unknown"?"unknown":"candidate"};
  });
  for(let i=0;i<fields.length;i++) {
    const field=fields[i]!;
    if(field.key!=="unknown")continue;
    const previous=fields[i-1];
    if (previous?.key==="username")field.key="password";
    else if (previous?.key==="email")field.key="emailPassword";
    if(field.key!=="unknown") {field.label=FIELD_LABELS[field.key]+"候補";field.confidence="candidate";}
  }
  return {candidates:unique,fields,warnings,separators};
}
