// Buyer-facing texts for Xaccount-Bot payment bridge results
// (/api/shiire/payment/receive returns them as `reason` / `error`).

const REJECTED:Record<string,string>={
  PAYPAY_MONEY_LIGHT_NOT_ALLOWED:"PayPayマネーライトを含む送金リンクは無在庫販売では利用できません。PayPayマネーのみのリンクを入力してください。",
  PAYPAY_BALANCE_TYPE_UNKNOWN:"PayPay残高の種類を確認できないため受け取りませんでした。PayPayマネーのみのリンクを入力してください。",
  PAYPAY_AMOUNT_INSUFFICIENT:"送金リンクの金額が不足しています。支払額と同じ金額のリンクを入力してください。",
  PAYPAY_AMOUNT_MISMATCH:"送金リンクの金額が支払額と一致しません。支払額ちょうどのリンクを入力してください。",
  AMOUNT_MISMATCH:"送金リンクの金額が支払額と一致しません。支払額ちょうどのリンクを入力してください。",
  PAYPAY_LINK_INVALID:"PayPay送金リンクが正しくありません。リンクをそのまま貼り付けてください。",
  BAD_LINK:"PayPay送金リンクが正しくありません。リンクをそのまま貼り付けてください。",
  PAYPAY_LINK_ALREADY_COMPLETED:"このリンクは既に受け取り済みです。新しい送金リンクを入力してください。",
  NOT_PENDING:"このリンクは未受取状態ではありません。新しい送金リンクを入力してください。",
  BLOCKED_OR_PASSCODE:"ブロック中またはパスコード付きのリンクは利用できません。パスコードなしで送金し直してください。",
  EXPIRED:"PayPayリンクの有効期限が切れています。新しい送金リンクを入力してください。",
  SELF_PAYMENT:"送金元と受取先が同じリンクは利用できません。",
  KYASH_LINK_INVALID:"Kyash送金リンクを確認できませんでした。リンクをそのまま貼り付けてください。"
};

const PENDING:Record<string,string>={
  LOGIN_REQUIRED:"販売者のPayPayログインを確認中です。送金リンクは保持したまま、販売者の再ログイン後に自動で受け取ります。同じリンクを再送したり新しく送金したりしないでください。",
  LINK_UNAVAILABLE:"PayPayに一時的につながりません。送金リンクは保持したまま1分ごとに自動確認します。",
  TEMPORARY_HOLD:"PayPay側で一時保留になっている可能性があります。PayPayアプリで送金の状態を確認し、解除操作が表示される場合は解除してください。解除後は自動で受取状況を再確認します。確認が終わるまで、同じリンクを再送したり新しい送金をしたりしないでください。"
};

export function paymentRejectedMessage(reason:string|null|undefined){
  return REJECTED[String(reason??"")]??"決済を確認できませんでした。別の有効な送金リンクを入力してください。";
}

export function paymentPendingMessage(reason:string|null|undefined){
  return PENDING[String(reason??"")]??"決済受取が保留されています。1分ごとに自動確認します。";
}
