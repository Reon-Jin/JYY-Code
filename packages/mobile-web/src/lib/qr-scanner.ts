import type { IScannerControls } from "@zxing/browser"

export async function startQrScanner(
  video: HTMLVideoElement,
  onResult: (text: string) => void,
  onError: (message: string) => void,
) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前 Safari 无法访问相机，请改用粘贴二维码内容")
  const { BrowserQRCodeReader } = await import("@zxing/browser")
  const reader = new BrowserQRCodeReader()
  let controls: IScannerControls | undefined
  try {
    controls = await reader.decodeFromConstraints(
      {
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
      },
      video,
      (result, error) => {
        if (result) {
          controls?.stop()
          onResult(result.getText())
        } else if (error && error.name !== "NotFoundException") {
          onError("无法识别二维码，请保持画面清晰")
        }
      },
    )
  } catch {
    throw new Error("无法打开相机，请检查 Safari 相机权限")
  }
  return () => controls?.stop()
}
