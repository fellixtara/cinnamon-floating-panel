# Floating Panel

Extension Cinnamon yang mengubah panel horizontal (atas/bawah) menjadi *pill* rounded yang mengambang: satu pill untuk seluruh panel, atau satu pill per zona kiri, tengah, kanan.

Dibuat untuk Linux Mint 22.3 (Cinnamon 6.6, X11). Cocok dipakai bersama [Cinnamon Island](https://github.com/fellixtara/cinnamon-island-custom).

## Screenshot

**Satu panel** (Separate off)

![Satu panel](screenshots/single.png)

**Separate on**: zona kiri dan kanan jadi pill sendiri, zona tengah yang kosong tidak digambar

![Separate](screenshots/separate.png)

## Pasang

### Dari Releases
1. Unduh `floating-panel@fellixtara-<versi>.zip` dari halaman [Releases](https://github.com/fellixtara/cinnamon-floating-panel/releases).
2. Ekstrak ke folder extension:
   ```bash
   unzip floating-panel@fellixtara-*.zip -d ~/.local/share/cinnamon/extensions/
   ```
3. Aktifkan di *System Settings → Extensions → Floating Panel*.

### Dari git
```bash
git clone git@github.com:fellixtara/cinnamon-floating-panel.git \
  ~/.local/share/cinnamon/extensions/floating-panel@fellixtara
```
Lalu aktifkan seperti di atas.

## Pengaturan

*System Settings → Extensions → Floating Panel → ⚙*. Semua perubahan langsung berlaku.

**General panel options**

| Opsi | Default |
|---|---|
| Separate the panel into left, center and right | off |
| Gap between the zones (aktif kalau Separate on) | 8 px |
| Margin atas / kanan / bawah / kiri | 4 / 8 / 4 / 8 px |
| Rounded corners | 15 px (≥ setengah tinggi panel = ujung bulat penuh) |
| Jarak tepi pill ke applet | 8 px |

**Appearance**

| Opsi | Default |
|---|---|
| Background colour | `rgb(30, 30, 36)` |
| Transparency | 15 % (0 = solid, 100 = tak terlihat) |

**Appearance → Right panel icons**

| Opsi | Default |
|---|---|
| Use the extension's own icons for some tray apps (9Router) | on |
| Give all icons in the right zone one colour | off (setiap app memakai warnanya sendiri) |
| Icon colour | putih |

Kalau on, setiap ikon dan teks di zona kanan (tray, sound, network, suhu, ...) memakai satu warna. Ikon gambar dari aplikasi tray dibaca piksel per piksel supaya hasilnya tetap jelas:

- **Bentuk terang dengan garis tepi gelap** (misalnya Slack): garis tepinya dibuang, lalu bentuknya diwarnai.
- **Kotak berwarna dengan simbol terang** (misalnya 9Router): kotaknya diwarnai dan simbolnya jadi lubang, seperti ikon simbolik.
- **Bentuk gelap untuk panel terang** (misalnya zapfast): bentuknya diwarnai, sedangkan detail yang berlubang tetap berlubang.
- **Titik notifikasi berwarna** (merah, biru, ...) tetap memakai warna aslinya.

**Ikon pengganti.** 9Router (nama ikon tray `tray_linux_release`) diganti dengan SVG milik extension di `icons/`:

- Default: `9router.svg`, logo jaringan putih di atas kotak oranye.
- Mode satu warna: `9router-symbolic.svg`, logo saja tanpa kotak, diwarnai dengan warna pilihan.

Daftar penggantinya ada di `CUSTOM_ICONS` di `extension.js`. Ikon tray lain tidak diubah ke SVG. Aplikasi mengirim ulang gambar ikonnya setiap kali ada notifikasi, jadi salinan SVG akan ketinggalan. Pewarnaan dilakukan langsung pada gambar yang sedang tampil. Ikon aplikasi baru di panel kanan, atau ikon yang diganti aplikasinya, otomatis ikut diwarnai dalam 2 detik.

**Appearance → Dropdown menus** (menu yang dibuka dari applet panel: sound, network, menu, ...)

| Opsi | Default |
|---|---|
| Use these colours for the dropdown menus | on (off = warna tema) |
| Also colour the menus of tray apps (Bluetooth, Slack, ...) | on |
| Menu utama: background / transparency / teks | `rgb(33, 33, 33)` / 5 % / putih |
| Submenu (bagian yang bisa dibuka-tutup, kartu pemutar musik): background / transparency / teks | `rgb(48, 48, 52)` / 0 % / `rgb(235, 235, 235)` |

Opsi ini dibuat karena submenu tema Orchis-Dark berlatar terang dengan teks putih sehingga tidak terbaca.

**Menu ikon tray.** Ikon seperti Bluetooth, Slack, dan Flameshot ditampilkan oleh applet `xapp-status`. Menunya adalah menu GTK yang digambar oleh aplikasinya sendiri, bukan oleh Cinnamon. Warnanya (memakai warna menu utama) ditulis ke blok bertanda di `~/.config/gtk-3.0/gtk.css`.

- GTK hanya membaca file itu saat aplikasi mulai. Karena itu extension me-restart `xapp-sn-watcher` (layanan yang menggambar menu sebagian besar ikon tray) sekitar 1,5 detik setelah warna terakhir diubah. Ikon tray hilang sebentar lalu muncul lagi.
- Update Manager (mintUpdate) dan System Reports (mintreport) menggambar menunya sendiri, jadi keduanya ikut di-restart ke tray. Kalau sedang sibuk (misalnya update berjalan), aplikasi itu dilewati dan baru berubah saat dijalankan ulang.
- Border menu dihapus, baik di menu Cinnamon maupun di menu GTK.
- Menu klik kanan aplikasi GTK 3 lain (misalnya Nemo) juga ikut warna ini.
- Mematikan opsi ini atau menonaktifkan extension akan menghapus blok tersebut. Isi lain di `gtk.css` tidak disentuh.

## Cara kerja

- Panel tetap menempel ke tepi layar, dan margin adalah ruang kosong di dalamnya. Jadi jendela yang di-maximize tidak menutupi panel.
- Tinggi panel di *System Settings → Panel* menjadi tinggi pill. Margin atas/bawah ditambahkan di luarnya, sehingga ukuran ikon applet tidak berubah.
- Di mode Separate, tiap pill selebar isinya. Zona tanpa applet disembunyikan. *Gap* adalah jarak minimum antar pill, terlihat saat zona saling mendekat.
- Panel vertikal tidak diubah.
- Warna menu diterapkan lewat stylesheet yang dibuat di `$XDG_RUNTIME_DIR/floating-panel@fellixtara/`. Setiap perubahan memuat ulang tema Cinnamon (tanpa logout) supaya menu yang sudah ada ikut berubah.
- Menonaktifkan extension mengembalikan tampilan panel dari tema.

## Pengembangan

Reload tanpa logout:
```bash
dbus-send --session --print-reply --dest=org.Cinnamon /org/Cinnamon \
  org.Cinnamon.ReloadXlet string:'floating-panel@fellixtara' string:'EXTENSION'
```
Membuat zip release:
```bash
./tools/make-release.sh        # hasil: dist/floating-panel@fellixtara-<versi>.zip
```

## Lisensi

GPL-3.0-or-later (lihat `LICENSE`).
