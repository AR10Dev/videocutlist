// Package interchange converts bounded, path-free cut lists to and from text formats.
package interchange

import (
	"bytes"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"unicode/utf8"

	"videocutlist/domain"
)

const MaxInputBytes = 1 << 20

var errInvalid = errors.New("invalid interchange document")

func ParseCSV(data []byte, durationMS int64) ([]domain.Segment, error) {
	if len(data) > MaxInputBytes || bytes.ContainsAny(data, "\\") {
		return nil, errInvalid
	}
	r := csv.NewReader(bytes.NewReader(data))
	r.FieldsPerRecord = 3
	head, err := r.Read()
	if err != nil || len(head) != 3 || head[0] != "start" || head[1] != "end" || head[2] != "label" {
		return nil, errInvalid
	}
	var out []domain.Segment
	for {
		row, e := r.Read()
		if e == io.EOF {
			break
		}
		if e != nil || len(out) >= 10000 {
			return nil, errInvalid
		}
		if strings.ContainsAny(row[2], "/\\") || utf8.RuneCountInString(row[2]) > 200 {
			return nil, errInvalid
		}
		start, e1 := ParseTimestamp(row[0])
		end, e2 := ParseTimestamp(row[1])
		if e1 != nil || e2 != nil {
			return nil, errInvalid
		}
		out = append(out, domain.Segment{StartMS: start, EndMS: end, Label: row[2]})
	}
	return validate(out, durationMS)
}

func ExportCSV(document domain.Document) ([]byte, error) {
	if _, err := validate(document.Segments, 0); err != nil {
		return nil, err
	}
	var b bytes.Buffer
	w := csv.NewWriter(&b)
	_ = w.Write([]string{"start", "end", "label"})
	for _, s := range document.Segments {
		_ = w.Write([]string{FormatTimestamp(s.StartMS), FormatTimestamp(s.EndMS), s.Label})
	}
	w.Flush()
	return b.Bytes(), w.Error()
}

func ParseChapters(data []byte, durationMS int64) ([]domain.Segment, error) {
	if len(data) > MaxInputBytes || bytes.ContainsAny(data, "\\") || durationMS <= 0 {
		return nil, errInvalid
	}
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	var starts []domain.Segment
	for _, line := range lines {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			return nil, errInvalid
		}
		start, err := ParseTimestamp(fields[0])
		if err != nil {
			return nil, errInvalid
		}
		end := int64(0)
		titleOffset := len(fields[0])
		if len(fields) >= 4 && fields[1] == "-->" {
			// Canonical form is: start --> end title. The explicit end preserves
			// gaps and a final segment that ends before media duration.
			end, err = ParseTimestamp(fields[2])
			if err != nil {
				return nil, errInvalid
			}
			titleOffset += len(line[titleOffset:]) - len(strings.TrimLeft(line[titleOffset:], " \t"))
			titleOffset += len(fields[1])
			titleOffset += len(line[titleOffset:]) - len(strings.TrimLeft(line[titleOffset:], " \t"))
			titleOffset += len(fields[2])
		}
		title := strings.TrimSpace(line[titleOffset:])
		if title == "" || strings.ContainsAny(title, "/\\") || utf8.RuneCountInString(title) > 200 {
			return nil, errInvalid
		}
		starts = append(starts, domain.Segment{StartMS: start, EndMS: end, Label: title})
	}
	if len(starts) == 0 {
		return nil, errInvalid
	}
	for i := range starts {
		if starts[i].EndMS == 0 {
			if i+1 < len(starts) {
				starts[i].EndMS = starts[i+1].StartMS
			} else {
				starts[i].EndMS = durationMS
			}
		}
	}
	return validate(starts, durationMS)
}

func ExportChapters(document domain.Document) ([]byte, error) {
	if _, err := validate(document.Segments, 0); err != nil {
		return nil, err
	}
	var b strings.Builder
	for _, s := range document.Segments {
		fmt.Fprintf(&b, "%s --> %s %s\n", FormatTimestamp(s.StartMS), FormatTimestamp(s.EndMS), s.Label)
	}
	return []byte(b.String()), nil
}

func ParseTimestamp(value string) (int64, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsAny(value, "/\\") {
		return 0, errInvalid
	}
	parts := strings.Split(value, ":")
	if len(parts) == 1 {
		return parseSecondsMillis(parts[0])
	}
	if len(parts) != 2 && len(parts) != 3 {
		return 0, errInvalid
	}
	var h, m int64
	var err error
	if len(parts) == 3 {
		h, err = parseUnsigned(parts[0])
		if err != nil {
			return 0, errInvalid
		}
		m, err = parseUnsigned(parts[1])
	} else {
		m, err = parseUnsigned(parts[0])
	}
	if err != nil || m >= 60 {
		return 0, errInvalid
	}
	sec, err := parseSecondsMillis(parts[len(parts)-1])
	if err != nil || sec >= 60000 {
		return 0, errInvalid
	}
	hours, ok := checkedMul(h, 3600000)
	if !ok {
		return 0, errInvalid
	}
	minutes, ok := checkedMul(m, 60000)
	if !ok {
		return 0, errInvalid
	}
	base, ok := checkedAdd(hours, minutes)
	if !ok {
		return 0, errInvalid
	}
	result, ok := checkedAdd(base, sec)
	if !ok {
		return 0, errInvalid
	}
	return result, nil
}

func parseSecondsMillis(value string) (int64, error) {
	parts := strings.Split(value, ".")
	if len(parts) > 2 || parts[0] == "" {
		return 0, errInvalid
	}
	seconds, err := parseUnsigned(parts[0])
	if err != nil {
		return 0, errInvalid
	}
	fraction := int64(0)
	if len(parts) == 2 {
		if len(parts[1]) > 3 || parts[1] == "" {
			return 0, errInvalid
		}
		fraction, err = parseUnsigned(parts[1])
		if err != nil {
			return 0, errInvalid
		}
		if len(parts[1]) == 1 {
			fraction *= 100
		}
		if len(parts[1]) == 2 {
			fraction *= 10
		}
	}
	result, ok := checkedMul(seconds, 1000)
	if !ok {
		return 0, errInvalid
	}
	result, ok = checkedAdd(result, fraction)
	if !ok {
		return 0, errInvalid
	}
	return result, nil
}
func parseUnsigned(value string) (int64, error) {
	if value == "" || strings.HasPrefix(value, "-") {
		return 0, errInvalid
	}
	n, err := strconv.ParseUint(value, 10, 63)
	return int64(n), err
}
func checkedMul(a, b int64) (int64, bool) {
	if a < 0 || b < 0 || a > int64(^uint64(0)>>1)/b {
		return 0, false
	}
	return a * b, true
}
func checkedAdd(a, b int64) (int64, bool) {
	if a < 0 || b < 0 || a > int64(^uint64(0)>>1)-b {
		return 0, false
	}
	return a + b, true
}
func FormatTimestamp(ms int64) string {
	h := ms / 3600000
	m := (ms % 3600000) / 60000
	s := (ms % 60000) / 1000
	milli := ms % 1000
	return fmt.Sprintf("%02d:%02d:%02d.%03d", h, m, s, milli)
}
func validate(segments []domain.Segment, durationMS int64) ([]domain.Segment, error) {
	if len(segments) > 10000 {
		return nil, errInvalid
	}
	var prevStart, prevEnd int64 = -1, -1
	for _, s := range segments {
		if s.StartMS < 0 || s.EndMS <= s.StartMS || durationMS > 0 && s.EndMS > durationMS || s.StartMS <= prevStart || s.StartMS < prevEnd || strings.ContainsAny(s.Label, "/\\") {
			return nil, errInvalid
		}
		prevStart, prevEnd = s.StartMS, s.EndMS
	}
	return segments, nil
}
