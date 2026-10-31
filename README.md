# CodeDesk

Ứng dụng Windows để giao việc lập trình cho DeepSeek hoặc dịch vụ cung cấp API Chat Completions tương thích OpenAI. AI có thể đọc dự án, tìm mã, tạo/sửa file và chạy lệnh qua công cụ của ứng dụng.

## Bắt đầu

1. Chạy `release/CodeDesk-0.1.0-Windows.exe` nếu đã đóng gói, hoặc `release/win-unpacked/CodeDesk.exe`.
2. Mở **Cài đặt API**, nhập Base URL, tên model và API key của nhà cung cấp.
3. Với DeepSeek trực tiếp, Base URL là `https://api.deepseek.com`, model mặc định `deepseek-flash`. Có thể nhập tên model khác do nhà cung cấp của bạn hỗ trợ.
4. Dùng nút kiểm tra kết nối, lưu cấu hình, rồi mở một thư mục dự án.
5. Nhập yêu cầu cụ thể, ví dụ: “Đọc dự án và giải thích cấu trúc”, hoặc “Sửa lỗi đăng nhập, sau đó chạy test liên quan”.

API trung gian cần hỗ trợ **Chat Completions, streaming và tool calling**. API chỉ trả lời chat văn bản sẽ không đủ để vận hành vòng lặp agent. CodeDesk dùng endpoint `{Base URL}/chat/completions`; Base URL có thể đã bao gồm `/v1`.

## Những gì bản này làm được

- Chat có phản hồi trực tiếp khi model đang trả lời.
- Chọn dự án, duyệt cây file, mở và lưu file trong trình soạn thảo.
- AI gọi công cụ đọc, tìm, tạo/sửa file và chạy PowerShell.
- Xem đề xuất sửa file bằng diff và duyệt hoặc từ chối.
- Duyệt lệnh trước khi AI chạy; có tùy chọn tự động duyệt riêng cho sửa file và chạy lệnh.
- Dừng tác vụ đang chạy, bắt đầu chat mới, lưu cuộc trò chuyện cục bộ.
- Đổi Base URL, model và API key để dùng nhà cung cấp khác.

## Quyền và dữ liệu

- API key được mã hóa bằng Electron `safeStorage` của Windows trước khi ghi đĩa. Giao diện không nhận lại key đã lưu.
- Cấu hình và lịch sử chat lưu trong thư mục dữ liệu ứng dụng của Windows, thường là `%APPDATA%/CodeDesk`.
- File mà AI đọc cùng yêu cầu và kết quả công cụ sẽ được gửi đến nhà cung cấp API bạn đã cấu hình. Ứng dụng không tự tải toàn bộ thư mục lên.
- Công cụ file giới hạn trong dự án đã chọn, kiểm tra đường dẫn thật để chặn thoát thư mục qua symlink/junction. Một số file chứa thông tin bí mật và thư mục sinh tự động được bỏ qua.
- **Lệnh terminal chạy bằng quyền tài khoản Windows hiện tại. Đây là PowerShell thực, không phải sandbox.** Tự động duyệt lệnh chỉ phù hợp khi bạn tin tưởng tác vụ và nội dung dự án.
- Bản đầu tiên có một cuộc trò chuyện hoạt động cho dự án. Chuyển dự án sẽ bắt đầu ngữ cảnh mới. Chất lượng mã và khả năng hoàn thành tác vụ phụ thuộc vào model/API.

## Chạy từ mã nguồn

Cần Windows và Node.js 22.12+ (hoặc Node.js 24 LTS).

```powershell
npm ci
npm run dev
```

Chạy bản đã build:

```powershell
npm run build
npm start
```

Đóng gói:

```powershell
npm run dist
```

File chạy được tạo ở `release/CodeDesk-0.1.0-Windows.exe`. Bản này chưa ký chứng chỉ phát hành Windows.

## Kiểm tra

```powershell
npm run typecheck
npm test
npm run test:desktop
```

Bài kiểm tra desktop dùng Electron và máy chủ API giả lập cục bộ để kiểm tra luồng thao tác mà không cần API key thật hoặc phát sinh phí API. Việc gọi DeepSeek thật cần key của bạn.

## Cấu trúc

- `electron/`: tiến trình desktop, lưu cấu hình, kết nối API, vòng lặp agent và công cụ.
- `src/`: giao diện React.
- `shared/types.ts`: hợp đồng dữ liệu giữa giao diện và tiến trình desktop.
- `tests/`: kiểm tra đường dẫn, file, API và công cụ.
- `scripts/`: chạy phát triển và kiểm tra desktop.

Tài liệu API: [DeepSeek](https://api-docs.deepseek.com/), [tool calling](https://api-docs.deepseek.com/guides/tool_calls/).

## Giấy phép

[MIT](LICENSE) — Copyright (c) 2026 dtai52hz.
