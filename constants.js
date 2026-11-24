export const STORAGE_KEY = 'ontap_exams_v1';

export const PROGRESS_STORAGE_KEY = 'ontap_quiz_progress_v1';

export const HISTORY_STORAGE_KEY = 'ontap_quiz_history_v1';

export const PROFILE_STORAGE_KEY = 'ontap_profile_v1';

export const TURBO_PREF_KEY = 'ontap_turbo_mode_v1';

export const FOLDERS_STORAGE_KEY = 'ontap_folders_v1';

export const MAX_HISTORY_ENTRIES = 500;

export const PRESET_FOLDERS = ['Toán', 'Vật lý', 'Hóa học', 'Sinh học', 'Tiếng Anh', 'Tin học'];

export const TIMER_PRESET_MINUTES = [15, 30, 45, 50, 60, 90];

export const SAMPLE_YAML = `meta:
  title: "Đề ôn tập Toán - Vật lý mẫu"

sections:
  - title: "Phần I. Trắc nghiệm nhiều phương án lựa chọn"
    questions:
      - type: multiple_choice
        question: "Cho hàm số $f(x) = \\frac{2x + 1}{x - 1}$. Giá trị của $f(2)$ bằng:"
        options:
          A: "$3$"
          B: "$4$"
          C: "$5$"
          D: "$6$"
        answer: "C"
        explanation: "Thay $x = 2$ ta có $f(2) = \\frac{2 \\times 2 + 1}{2 - 1} = 5$."

      - type: multiple_choice
        question: |
          Cho hàm số $f(x) = x^2 - 4x + 3$ trên đoạn $[0; 3]$.
          Tìm **giá trị nhỏ nhất** của hàm số và từ khóa \`min\`:
        options:
          A: "$-1$"
          B: "$0$"
          C: "$3$"
          D: "$-3$"
        answer: "A"
        explanation: "Đỉnh parabol tại $x = 2 \\in [0; 3]$ cho $f(2) = -1$."

  - title: "Phần II. Trắc nghiệm đúng sai"
    questions:
      - type: true_false
        question: |
          Một vật chuyển động với vận tốc $v(t) = 2t + 1$ (m/s).
          Xét tính đúng sai của các **khẳng định** sau:
        statements:
          - text: "Tại $t = 0$, vận tốc bằng $1\\text{ m/s}$"
            is_true: true
          - text: "Gia tốc của vật là $a = 2\\text{ m/s}^2$"
            is_true: true
          - text: "Quãng đường đi được trong $2\\text{ s}$ đầu là $\\int_0^2 (2t + 1)\\,dt = 5\\text{ m}$"
            is_true: false
          - text: "Vận tốc đạt $10\\text{ m/s}$ tại ++thời điểm++ $t = 4,5\\text{ s}$"
            is_true: true

  - title: "Phần III. Trả lời ngắn"
    questions:
      - type: short_answer
        question: |
          Biết phương trình $2x - 15 = 0$ có nghiệm $x_0$.
          Tính giá trị biểu thức: $P = x_0$.
        accepted_answers:
          - "7,5"
          - "7.5"
        explanation: "Từ $2x - 15 = 0$ suy ra $x_0 = \\frac{15}{2} = 7,5$."

      - type: short_answer
        question: |
          Cho bảng tần số ghép nhóm số liệu thống kê:
          | Nhóm | $[0; 10)$ | $[10; 20)$ | $[20; 30)$ |
          | :--- | :---: | :---: | :---: |
          | Tần số $n$ | $5$ | $12$ | $8$ |
          Tính cỡ mẫu $N$ của bảng số liệu trên:
        accepted_answers:
          - "25"
        explanation: "Cỡ mẫu $N = 5 + 12 + 8 = 25$."
`;

export function buildAiPrompt(title, { folder = '', timeLimit = '' } = {}) {
  const safeTitle = String(title || 'Tên đề ôn tập').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const cleanFolder = String(folder || 'Toán').trim() || 'Toán';
  const safeFolder = cleanFolder.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const parsedLimit = Number(timeLimit);
  const safeTimeLimit = Number.isInteger(parsedLimit) && parsedLimit >= 1 && parsedLimit <= 600
    ? parsedLimit
    : 90;

  return `Bạn là chuyên gia số hóa đề thi sang định dạng YAML cho ứng dụng OTDO.

0. HƯỚNG DẪN TÌNH HUỐNG (NẾU NGƯỜI DÙNG CHƯA BIẾT CÁCH DÙNG HOẶC CHƯA GỬI ĐỀ):
- Nếu người dùng dán prompt này mà CHƯA gửi kèm nội dung/ảnh đề thi, hoặc hỏi cách dùng: TUYỆT ĐỐI KHÔNG tự bịa đề hay xuất YAML mẫu. Hãy trả lời thân thiện bằng tiếng Việt theo đúng 3 bước sau:
  1) Bảo người dùng gửi đề thi cần làm (dán chữ, tải ảnh chụp, PDF hoặc file Word) và cho biết thêm nếu cần: môn học, thời gian làm bài (phút), và đề đã có sẵn đáp án/lời giải hay cần AI tự giải giúp.
  2) Nhắc người dùng chỉ cần sao chép khối \`\`\`yaml ... \`\`\` bạn trả về; nếu đề dài quá bạn sẽ chia thành nhiều lượt, khi thấy chữ nhắn "tiếp" là bạn xuất phần còn lại để người dùng dán nối xuống dưới.
  3) Hướng dẫn đưa lên web: Mở mục "Biên tập" -> dán YAML vào khung soạn thảo bên phải (hoặc lưu thành file .yaml rồi bấm nút "Import") -> kiểm tra khung bên trái không còn dòng báo lỗi đỏ -> bấm "Lưu đề" để bắt đầu làm bài.

1. QUY TẮC SCHEMA YAML BẮT BUỘC (KHI ĐÃ CÓ ĐỀ THI):
- Chỉ dùng đúng 2 dấu cách (2 spaces) để thụt lề, TUYỆT ĐỐI KHÔNG dùng phím Tab.
- Hai trường gốc bắt buộc:
  + meta: bắt buộc "title"; tùy chọn "folder" (tên môn/thư mục) và "time_limit" (số nguyên dương 1..600, đơn vị phút).
  + sections: danh sách các Phần, mỗi phần có "title", tùy chọn "points" (tổng điểm phần), và "questions".
- Mỗi câu hỏi bắt buộc có "type" là 1 trong 4 loại sau (không thêm key lạ ngoài schema):
  + multiple_choice: "question", "options" (đủ 4 khóa A, B, C, D), "answer" (chỉ 1 ký tự A/B/C/D).
  + true_false: "question", "statements" (1..8 ý, mỗi ý có "text" và "is_true": true hoặc false — viết boolean không bọc ngoặc kép).
  + short_answer: "question", "accepted_answers" (danh sách đáp án đúng; nếu là số thập phân LUÔN liệt kê cả dấu phẩy và dấu chấm, vd "1,76" và "1.76").
  + group (dùng cho bài đọc hiểu, điền khuyết nhiều câu chung đoạn văn/ngữ liệu): "content" (đoạn văn/ngữ liệu chung, hỗ trợ Markdown/LaTeX/bảng), tùy chọn "title" và "points", cùng danh sách "questions" (1..50 câu hỏi con). Mỗi câu con: "type" tùy chọn (mặc định multiple_choice, cũng hỗ trợ true_false/short_answer), "question" tùy chọn (có thể bỏ qua với bài điền khuyết đánh số (1), (2)...), "options" (object đủ 4 khóa A, B, C, D), "answer" (A/B/C/D), tùy chọn "points" và "explanation".
- Tùy chọn mỗi câu: "points" (số dương, vd THPT: TN 0.25, Đ/S 1, TLN 0.5 — bỏ trống nếu chia đều) và "explanation" (lời giải chi tiết).

2. QUY TẮC LATEX, BẢNG VÀ TRÁNH LỖI CÚ PHÁP YAML:
- Công thức Toán/Lý/Hóa bọc trong \`$...$\` (inline) hoặc \`$$...$$\` (khối riêng). Có thể dùng \`**đậm**\`, \`*nghiêng*\`, \`++gạch chân++\`, \`\\\`code\\\`\`.
- Bảng số liệu 2D / Bảng biến thiên viết bằng bảng Markdown (\`| Cột | ... |\`) đặt trong khối \`question: |-\`.
- Mọi nội dung nhiều dòng, có bảng Markdown, có gạch đầu dòng \`-\`, hoặc chứa dấu hai chấm kèm dấu cách (\`: \`) NÊN dùng khối \`|-\` (thụt lề dòng con 2 spaces) để giữ nguyên dấu \`\\\` của LaTeX và tránh lỗi cú pháp YAML.
- Nếu viết chuỗi bọc ngoặc kép \`"..."\` trên 1 dòng, phải nhân đôi dấu gạch chéo thành \`\\\\\`.

3. QUY TẮC XỬ LÝ ĐỀ DÀI (CHIA NHIỀU LƯỢT, KHÔNG CẮT XÉN):
- Tuyệt đối KHÔNG tóm tắt, KHÔNG viết \`...\` hay bỏ bớt câu/lời giải khi đề dài.
- Nếu đề ngắn/vừa (fit trong 1 lượt): chỉ trả về đúng 1 khối \`\`\`yaml ... \`\`\` duy nhất, không thêm lời thừa bên ngoài.
- Nếu đề quá dài (>15-20 câu hoặc lời giải dài dễ chạm giới hạn ký tự): hãy tự động chia thành nhiều lượt sạch sẽ:
  + Lượt 1: Xuất \`meta:\`, \`sections:\` và các Phần/câu đầu tiên hoàn chỉnh trong \`\`\`yaml ... \`\`\`. Bên ngoài khối code ghi ngắn gọn: "(Đã xong Lượt 1: hết Câu ... — Nhắn \`tiếp\` để mình xuất phần còn lại)".
  + Lượt tiếp theo (khi người dùng nhắn "tiếp"): xuất tiếp đúng phần YAML còn lại (giữ nguyên mức thụt lề 2 spaces của \`  - title:\` nếu sang phần mới, hoặc 6 spaces \`      - type:\` nếu tiếp tục câu trong phần trước) để người dùng dán nối ngay dưới dòng cuối của lượt trước (KHÔNG lặp lại \`meta:\`). Ở lượt cuối cùng ghi thêm dòng: "— Hết đề." bên dưới khối code.

4. MẪU CHUẨN ĐIỂN HÌNH (ĐẦY ĐỦ 4 DẠNG CÂU + BẢNG MARKDOWN + LATEX + CHIA ĐIỂM):
\`\`\`yaml
meta:
  title: "${safeTitle}"
  folder: "${safeFolder}"
  time_limit: ${safeTimeLimit}
sections:
  - title: PHẦN I. Câu trắc nghiệm nhiều phương án lựa chọn
    questions:
      - type: multiple_choice
        question: Phương trình $\\sin x = 0$ có tập nghiệm là
        options:
          A: $S = \\left\\{-\\frac{\\pi}{2} + k2\\pi \\mid k \\in \\mathbb{Z}\\right\\}$.
          B: $S = \\{k\\pi \\mid k \\in \\mathbb{Z}\\}$.
          C: $S = \\{k2\\pi \\mid k \\in \\mathbb{Z}\\}$.
          D: $S = \\left\\{\\frac{\\pi}{2} + k2\\pi \\mid k \\in \\mathbb{Z}\\right\\}$.
        answer: B
        points: 0.25
        explanation: Phương trình lượng giác cơ bản $\\sin x = 0 \\Leftrightarrow x = k\\pi \\ (k \\in \\mathbb{Z})$.
      - type: multiple_choice
        question: |-
          Sau khi khảo sát về mức lương khởi điểm (đơn vị: triệu đồng) của $20$ công nhân, người ta thu được mẫu số liệu ghép nhóm như sau:

          | Mức lương | $[5; 6)$ | $[6; 7)$ | $[7; 8)$ | $[8; 9)$ | $[9; 10)$ | $[10; 11)$ |
          | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
          | Tần số | $4$ | $5$ | $5$ | $3$ | $2$ | $1$ |

          Khoảng biến thiên của mẫu số liệu ghép nhóm đó bằng
        options:
          A: $6$.
          B: $1$.
          C: $7,35$.
          D: $1,42$.
        answer: A
        points: 0.25
        explanation: Khoảng biến thiên của mẫu số liệu ghép nhóm là $R = 11 - 5 = 6$.
  - title: PHẦN II. Câu trắc nghiệm đúng sai
    questions:
      - type: true_false
        question: Cho hàm số $y = f(x) = x^3 - 6x^2 + 9x + 2$.
        statements:
          - text: Đạo hàm của hàm số đã cho là $f'(x) = 3x^2 - 12x + 9$.
            is_true: true
          - text: Phương trình $f'(x) = 0$ có tập nghiệm là $S = \\{1; 3\\}$.
            is_true: true
          - text: Hàm số đã cho đạt giá trị lớn nhất trên đoạn $[2; 4]$ tại $x = 2$.
            is_true: false
          - text: Gọi $x_1, x_2$ là hai điểm cực trị của hàm số $y = f(x)$. Khi đó, phương trình đường thẳng đi qua hai điểm $M_1(x_1; f(x_1))$ và $M_2(x_2; f(x_2))$ là $y = -2x + 1$.
            is_true: false
        points: 1
        explanation: |-
          a) Đúng: $f'(x) = 3x^2 - 12x + 9$.
          b) Đúng: $3x^2 - 12x + 9 = 0 \\Leftrightarrow x = 1$ hoặc $x = 3$.
          c) Sai: Trên $[2; 4]$, ta có $f(2) = 4$, $f(3) = 2$, $f(4) = 6$. Do đó GTLN là $6$ tại $x = 4$.
          d) Sai: Hai điểm cực trị là $M_1(1; 6)$ và $M_2(3; 2)$. Đường thẳng đi qua hai điểm này có phương trình $y = -2x + 8$.
  - title: PHẦN III. Câu trắc nghiệm trả lời ngắn
    questions:
      - type: short_answer
        question: |-
          Cho bảng $6 \\times 6$ gồm $36$ ô vuông đơn vị và cho $8$ quân cờ đôi một khác nhau. Người ta xếp ngẫu nhiên $8$ quân cờ đó vào $36$ ô trong bảng sao cho mỗi ô xếp nhiều nhất một quân cờ. Chọn ngẫu nhiên một cách xếp thỏa mãn đồng thời ba điều kiện sau:
          - Trên mỗi hàng có ít nhất một quân cờ;
          - Trên mỗi cột có ít nhất một quân cờ;
          - Mỗi quân cờ phải cùng hàng với đúng một quân cờ khác hoặc cùng cột với đúng một quân cờ khác.

          Giá trị của $9^4 P$ bằng bao nhiêu (làm tròn đến hàng phần trăm)?
        accepted_answers:
          - "1,76"
          - "1.76"
        points: 0.5
        explanation: |-
          Số cách chọn tập $8$ ô thỏa mãn gồm $2$ hàng đôi và $2$ cột đôi là:
          $$C_6^2 \\cdot C_6^2 \\cdot C_4^2 \\cdot C_4^2 = 15 \\cdot 15 \\cdot 6 \\cdot 6 = 8100.$$
          Suy ra $P = \\frac{8100}{C_{36}^8}$, do đó $9^4 P = \\frac{6561 \\cdot 8100}{30260340} \\approx 1,76$.
  - title: PHẦN IV. Đọc hiểu / Điền khuyết (nhóm câu hỏi chung ngữ liệu)
    questions:
      - type: group
        title: Cloze Passage 1
        content: |-
          Read the following passage and choose the correct option for each blank.

          Technology has **(1)** ______ the way students learn every day. Many schools now **(2)** ______ digital tools to support interactive lessons.
        points: 0.5
        questions:
          - options:
              A: transformed
              B: transform
              C: transforming
              D: transformation
            answer: A
            explanation: Sau trợ động từ "has" cần quá khứ phân từ (V3/ed) -> "transformed".
          - question: Choose the best verb for blank (2).
            options:
              A: adopt
              B: adapt
              C: adept
              D: admire
            answer: A
            explanation: Cụm từ "adopt digital tools" nghĩa là áp dụng các công cụ số.
\`\`\``;
}
